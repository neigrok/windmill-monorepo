# Windmill sync engine

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, steps, definitions
(`D-n`) and invariants (`INV-n`) are numbered so reviews and code can cite them.

## §0 Status and scope

**Status:** Specified; not yet implemented. The current roadmap wire is
[GRAPH_SYNC_DESIGN.md](../GRAPH_SYNC_DESIGN.md). Roadmap, journal and gym are not yet on the engine.

**In the engine:**
- record identity, deletion and spent ids;
- stamps, the HLC and the merge;
- per-intent admission, results and commands;
- per-scope sequencing and digests, paged pull and the live channel;
- the client replica: confirmed cache, durable outbox, undo holds and the device scope;
- the replica lifecycle (claim, sign-out) and conformance.

**Outside the engine** (none of these is a synced record):
- Presence and remote cursors, carried as ephemeral live-socket messages (§9.5).
- The global gym exercise seed catalog.
- Gym session shares and log shares; the roadmap share page, images and gallery; the roadmap
  home-list done/total read.
- Journal echoes, spans, nudges, voice and curation.
- The roadmap per-node workspace, which is device-only.
- Auth, billing, entitlements and reminders.
- Account deletion and export, which remove every scope an account owns.

---

## §1 Definitions

**D-1 Stamp.** A triple `(ms, counter, actor)`:
- `ms`: an unsigned integer below 2^53;
- `counter`: an unsigned 32-bit integer;
- `actor`: 1–64 bytes of printable ASCII.

It is encoded as the text `ms:counter:actor`, in decimal without leading zeros. The *unset stamp*
`0:0:` has an empty actor and is below every set stamp. Order is defined in §3.1.

**D-2 HLC and actor.** A client replica has one clock state `(ms, counter)`, persisted in
`ReplicaMeta.hlc` and shared by every engine instance (process or browser tab) that uses it; each
instance has its own fixed actor. The server has one clock. Actors are:
- a client instance: `r_` plus 12 random `[a-z0-9]`;
- the server: `srv`;
- migration: `mig` and `dev`.

**D-3 Replica.** One device's durable local store for one account binding. Its id is `rp_` plus 32
lowercase hex characters. One device database holds any number of replicas.

| State | Meaning |
|---|---|
| `anon` | No account. It never pushes. |
| `bound(A)` | Signed in as A. It pushes and pulls. |
| `dormant(A)` | A signed out. The confirmed cache is purged; the outbox is kept, not shown and not sent. |
| `unattributed` | The account is unknown. Not shown, never sent. Its entries have lineage `anon`, and leave it only by the lineage rule or an explicit discard (§7.10). |

The legacy owner-less stores are `unattributed`:
- Android gym `Seat.quarantine` (`"unattributed"`);
- iOS gym `SetQueue` and `LocalLog` key `quarantine`;
- iOS journal `windmill-journal-pages-v2-unclaimed.json`;
- web journal `wm.journal.v2.pages.unclaimed`.

**D-4 Scope.** The unit of sequencing, authorization, bootstrap and live delivery.

| Kind | Server key | Wire reference | Read | Write |
|---|---|---|---|---|
| product | `acct:<A>/<product>`, product ∈ {roadmap, gym, journal} | `self/<product>` | A | A |
| tree | `tree:<T>` | `tree/<T>` | owner; anyone when `meta.visibility ∈ {unlisted, public}` | owner |
| overlay | `acct:<A>/overlay/<T>` | `self/overlay/<T>` | A, while A can read `tree:<T>` | A, while A can read `tree:<T>` |
| device | client only | `device/<product>` | the replica | the replica |

`self` resolves to the authenticated account. A device scope is never sent and never merged.

**D-5 Scope state.** A server scope is `absent`, `alive` or `dead`.
- `tree:<T>` is created by, and dies with, its governing `tree` record `T` in the owner's
  `acct:<A>/roadmap`.
- Every `acct:*/overlay/<T>` dies in the same transaction as `tree:<T>`.
- Product scopes are alive for the account's lifetime.
- A dead scope never becomes alive (INV-13).

**D-6 Record.** `(scope, type, id)` with:
- an optional life `[alive|dead, stamp]`;
- an optional `born` stamp (the stamp of its create);
- named fields;
- the server-assigned `seq` (the scope seq of its last change);
- `rc` and `ru`: server receipt ms of the create and of the last change.

**D-7 Registry.** `sync-schema.json` (§2.4) declares every type, field and command. It is
code-generated into all four implementations.

**D-8 Identity class.** Each type has one:

| Class | Id | Presence |
|---|---|---|
| `minted` | CSPRNG, or seeded; in the type's pattern | life; death is terminal unless the type is `revivable` |
| `derived` | a CSPRNG id or `derive(label)` (D-26) | as minted; spent ids also reach clients (§6.7) |
| `keyed` | a natural key: a date, an id, or an array of ids | optional life, re-creatable by a newer stamp |
| `singleton` | a fixed name | none; it always exists |

A minted or derived type has an id space: `scope` or `global` (unique across all scopes of the type).
A **seeded** id is `<seed>-<n>`: a CSPRNG-minted id of the same scope, `-`, and a decimal ordinal
`n ≥ 1`. It is unique and unpredictable as its seed is, and a retried multi-write that repeats its
seed and ordinals produces the same ids. A seed leaves room for `-<n>` within the type's id pattern
for the largest ordinal the product produces: Appendix A bounds it for each product that seeds ids,
and seeds are minted within that bound.

**D-9 Field kinds.**

| Kind | Meaning |
|---|---|
| `lww` | last writer wins (§3.2) |
| `ranked` | the value of higher rank wins, then the later stamp (§3.2); the registry ranks the values |
| `fww` | first writer wins (§3.2) |
| `const` | joins as `fww`; a client writes it only in the create |
| `time` | a device-reported instant (epoch ms); joins as `const`; clamped at admission (§10.4) |
| `serial` | an integer assigned by the server at admission; clients never write or predict it |
| `text` | a string merged by the server (§6.11); clients never join it |

Every field also has:
- a **writer**: `client`, or `server` (only the server writes it);
- bounds, with a stated **unit**: `chars` (Unicode code points) or `bytes` (UTF-8), plus
  `domain` and `quantum` where the field has them.

`lww`, `ranked`, `fww`, `const` and `time` fields, life and born are **lattice fields**. `text` and
`serial` are **server-sequenced**.

**D-10 Reference.** A field or command argument typed `ref<type>` holds an id of that type. It drives
dependent folding and the write map (§7.7).

**D-11 Spent id.** An id whose record is dead, for a type whose death is terminal. A spent id is
never alive again (INV-2).

**D-12 Delta.** A partial record state: `(type, id)` plus any of life, born and fields with stamps.
A text field carries `{text, base}` (§6.11). A minted or derived delta always carries `born`.

**D-13 Intent.** The unit of admission: deltas for records of one scope, an optional guard list
(D-19), an optional command (D-20) and an optional `gestureId`. It is admitted atomically. An intent
is:
- *single-record* when it touches one `(type, id)`;
- *plain* when it is single-record and has no guard and no command;
- *import* when migration produced it (Appendix C); the effect is in §4.4.

**D-14 Gesture.** One user act. `commit` (§7.1) turns it into one intent (atomic) or one intent per
record. The intents of one gesture share one stamp and one `gestureId`.

**D-15 Intent states and outcomes.** States: `held`, `ready`, `sent`, `acked`. Terminal outcomes:
- `undone`: Undo while held;
- `coalesced`: merged into another intent;
- `resolved`: `ok`, and the scope's cursor covers it;
- `refused`: a notice holds it;
- `discarded`: the person discarded it (sign-out Discard, a lineage decision, or an explicit
  discard of a dormant or unattributed replica, §7.10).

Transitions are in §8.1.

**D-16 Result.** The server's one final answer per intent (§9.3):
- `ok`: with the scope seq after admission, a command's write map, and a detail;
- `refused`: with a code.

**D-17 Notice.** The durable, per-product client record of a refused intent, holding the code and the
intent's content.

**D-18 Seq, epoch, cursor.**
- `seq`: a per-scope counter, incremented once per committed intent that changes the scope.
- `epoch`: one random string for the whole server database, regenerated when the database is
  restored from a backup.
- A cursor is `(epoch, mode ∈ {boot, live}, seq, key?, asOf?)`.
- The *scope digest*: a per-scope sum of the hashes of the scope's alive rows (§6.12).

**D-19 Guard.** `(type, id, field, stamp | null)`. It holds iff the stored register's stamp equals
`stamp`, or the register is unset and `stamp` is null.

**D-20 Command and write map.** A command is a named server function (§6.4, Appendix A) that runs
inside admission and produces server-stamped deltas. Its `ok` result carries a **write map**: one
entry `{t, id, from?, born?, f?}` per record it wrote or resolved to, giving the id it mapped
`from`, the record's `born`, and the stamp of every field it wrote (§7.7).

**D-21 Hold.** A `releaseAt` on the intents of a destructive gesture. They are `held` (not sent)
until released (§7.3).

**D-22 Views.** `confirmed` is the cache of server rows. `drawn` and `stored` are the predictive
views (§7.6).

**D-23 Origin.**
- `replica(R, n)`: a client push.
- `server(A, requestId?)`: MCP, REST API, tending, or a server-internal command.

**D-24 Cap.** A per-type ceiling on alive records in a scope, enforced by the growth rule (§6.5).

**D-25 Fractional key.** The jitterless base-62 order key of
`web/src/products/roadmap/sync/fractionalIndex.js`.
- Keys compare bytewise, and a list sorts by `(key, id)`.
- `between(a, b)` returns a key strictly between `a` and `b`.
- When two neighbours hold equal keys, a key inserted after the first of them is
  `between(a, the next greater key)`.
- **Drop position.** A member dropped into a list takes a key between the `drawn` row immediately
  above the drop point and that row's successor in `stored` order, the moved member excluded; at
  the top, before the first `stored` row; with no `stored` successor, after the last `stored` row.
  A member inside a delete window (§7.3) so keeps its stored place.

**D-26 Derived id.** `derive(label, fallback, taken)`:

```
base := ""
for each byte c of UTF-8(label):
  if |base| = 40: stop
  if c ∈ [A-Za-z0-9]: append lowercase(c)
  else if base ≠ "" and last(base) ≠ '-': append '-'
remove trailing '-' from base
if base = "": base := fallback
id := base; k := 2
while id ∈ taken: id := base + "-" + decimal(k); k := k + 1
return id
```

`taken` is every alive, spent and pending id of the type in the scope, plus ids already chosen in
the same gesture.

**D-27 Lineage.** The account an outbox entry was committed under: an account id, or `anon` when it
was committed signed out. Migration gives an entry its seat's lineage, and `anon` for an
unattributed seat (C.7). It is set at commit, and changes only when the lineage rule adds the entry
to an account (§7.10). So every entry of a `bound(A)` or `dormant(A)` replica has lineage A, and
every entry of an `anon` or `unattributed` replica has lineage `anon`.

---

## §2 State

### §2.1 Server: generic platform tables

```sql
sync_meta    (epoch text not null)                           -- one row
sync_scopes  (key text primary key, kind text, owner uuid, governed_by text null, -- '<scope>#<type>#<id>'
              state text, seq bigint not null, counters jsonb not null,
              digest bytea not null, dead_at timestamptz null)  -- digest: the scope digest (§6.12)
sync_replicas(replica text primary key, account uuid not null, last_n bigint not null, last_seen timestamptz)
sync_results (replica text, n bigint, digest bytea not null, result jsonb null, faults int not null,
              primary key (replica, n))
sync_spent   (scope text, type text, id text, born text not null, life_stamp text not null, seq bigint not null,
              primary key (scope, type, id))            -- indexes (scope, seq); (type, id) for global id spaces
sync_requests(account uuid, request_id text, digest bytea not null, state text,   -- running | done
              result jsonb null, started_at timestamptz, primary key (account, request_id))
```

### §2.2 The envelope on typed product tables

Each table storing a synced type keeps its typed columns as the truth and adds:

| Column | On |
|---|---|
| `scope_key`, `seq`, index `(scope_key, seq)` | every synced table |
| `rc`, `ru` | every synced table |
| `<field>_stamp` | every lattice field (existing stamp columns satisfy this) |
| `born`, `life_stamp` | every type with life |
| `life` | types whose table keeps dead rows (`deadRows: keep`) |
| `<field>_rev`, `<field>_merged` | every `text` field |

- With `deadRows: spent`, the typed row is deleted at death and `sync_spent` holds
  `(id, born, life_stamp, seq)`.
- One table MAY host several types, each with its own envelope columns.
- Superseded text heads are kept in the product's revision table, keyed by `rev`.
- A foreign key between synced tables has no `ON DELETE` action. Every referential consequence of
  a delete is a write by admission, in the same seq (Appendix A lists them). `apply` writes the
  consequences before it removes the parent's typed row, children first.

### §2.3 The `SyncType` port

Platform code owns admission, identity, guards, counters, seq, results and spent ids. Each product
implements one port per type in its own adapter.

```cpp
struct Row    { Type t; Id id; std::optional<Life> life; std::optional<Stamp> born;
                std::map<Field, Reg> f;                 // lattice fields: [value, stamp]
                std::map<Field, TextVal> x;             // text: {text, rev, merged}
                std::map<Field, Json> v;                // serial values
                Seq seq; Ms rc, ru; };
enum class IdState { none, foreign, alive, dead };
struct Locked { IdState state; std::optional<Row> row; };
struct Change { Locked before; Row after; };
class SyncType {
 public:
  virtual const TypeDef& def() const = 0;
  virtual std::map<Id, Locked> lock(Txn&, const ScopeKey&, std::span<const Id>) = 0;  // FOR UPDATE; global lookup
  virtual Verdict check(Txn&, const AdmitCtx&, std::vector<Change>&) = 0;             // product rules (Appendix A)
  virtual void apply(Txn&, const ScopeKey&, Seq, const std::vector<Change>&) = 0;     // typed rows, revisions, projections
  virtual std::vector<Row> feed(Txn&, const ScopeKey&, const FeedQuery&) = 0;         // keyset (seq, type, id)
  virtual std::optional<std::string> revisionText(Txn&, const ScopeKey&, const Id&, Field, Seq rev) = 0;
};
```

### §2.4 The registry

```ts
type TypeDef = {
  type: string, scope: 'product:roadmap'|'product:gym'|'product:journal'|'tree'|'overlay',
  identity: 'minted'|'derived'|'keyed'|'singleton', idSpace?: 'scope'|'global', idPattern: string,
  life: boolean, revivable: boolean, deadRows: 'keep'|'spent',
  governs?: 'tree', origins: ('replica'|'server')[],
  fields: Record<string, { kind: 'lww'|'ranked'|'fww'|'const'|'time'|'serial'|'text', writer: 'client'|'server',
                           ref?: string, parent?: true, unit?: 'chars'|'bytes', max?: number,
                           domain?: string, quantum?: number, serialNext?: string[],
                           rank?: Record<string, number> }>,
  cap?: number, visibleWhen?: string[], primary?: true,
}
type CommandDef = { name: string, scope: string, origins: ('replica'|'server')[], serverInternal: boolean,
                    args: Record<string, 'json' | 'time' | 'instant' | `ref<${string}>`> }
```

- `parent: true` marks the one `ref` field whose target must be alive (§6.1 step 9).
- `rank` gives each value of a `ranked` field an integer rank; its keys are the field's domain.
- A type's `origins` always include `replica`: a replica MAY create a record of any type, by a
  delta or through a command as Appendix A binds it, and the product's `check` re-checks it (§6.1
  step 9).
- `primary` marks the types whose records make an account hold records in the product (§9.2);
  Appendix A lists them per product.
- `visibleWhen` lists fields: a record of a type without life is visible iff one of them holds a
  value other than null or `""`. Without it, any set field makes the record visible.
- A `time` argument is device-produced, like a `time` field. An `instant` argument is chosen by the
  user.

### §2.5 Client: the local store

The store MUST provide atomic, durable transactions spanning every table below.

```ts
type ReplicaMeta = { replica: string, state: 'anon'|'bound'|'dormant'|'unattributed', account?: string,
                     nextN: number, hlc: {ms: number, counter: number}, hlcHigh: Stamp, admittedHigh: Stamp,
                     serverOffsetMs: number, offsetSamples: {offset: number, rtt: number}[],
                     serverEpoch: string | null, ackThrough: number, forkGuard: string,
                     authPaused: boolean, liveHint: boolean }
type ConfirmedRow = Row                                  // keyed (replica, scope, type, id); replaced, never joined
type SpentId = { replica, scope, type, id, born }        // derived types only
type CursorRec = { replica, scope, cursor: string | null, digest: string, booted: boolean,
                   digestStop?: string }
type OutboxEntry = { localId, replica, gestureId, lineage: string /* account id | 'anon' */, scope,
                     state: 'held'|'ready'|'sent'|'acked',
                     commitOrder: number, releaseAt: number, n?, digest?, intent: Intent,
                     predict?: Delta[], baseTexts?: Record<string, string>,   // (t, id, field) → text edited from
                     resultSeq?: number, resultEpoch?: string, orphanOf?: string }
type Notice = { id, replica, scope, code: RefusalCode, detail?, content: { d?: Delta[], cmd?: Cmd }, at }
type DeviceRow = { replica, product, key, value: Json }  // device/<product>
```

- `hlcHigh`: the greatest stamp this replica minted or observed.
- `admittedHigh`: the greatest stamp in any row the server sent (pull, live) or in an acked entry.
- `CursorRec.digest`: the scope digest (§6.12) of the replica's confirmed rows of the scope. A boot
  into staging keeps its own digest until the swap (§7.5).
- `CursorRec.booted`: the scope's first pull is complete, a boot having finished with the cursor
  live (§7.5). It is deleted with the scope's cursor.
- `CursorRec.digestStop`: the app version at which digest checks of the scope stopped (§7.5).
- `forkGuard`: a random token kept both in the database and in storage excluded from device backups
  (iOS `isExcludedFromBackup`, Android `noBackupFilesDir`). Web runs no fork guard.

---

## §3 Merge

### §3.1 Stamp order

`a < b` iff `(a.ms, a.counter) < (b.ms, b.counter)` numerically, or both are equal and `a.actor` is
bytewise less than `b.actor`.

### §3.2 Lattice joins

`jcs(v)` is the RFC 8785 encoding of the JSON value `v`. JSON numbers are IEEE-754 doubles, and
integers stay below 2^53. An absent register is the bottom element.

```
joinLww(a, b):  a absent → b; b absent → a; stamps differ → the greater stamp; else the bytewise-greater jcs(value)
joinRanked(a, b): a absent → b; b absent → a; ranks differ → the higher rank; else joinLww(a, b)
joinFww(a, b):  a absent → b; b absent → a; stamps differ → the smaller stamp; else the bytewise-smaller jcs(value)
joinLife(a, b): a absent → b; b absent → a; stamps differ → the greater stamp; else the alive one
joinBorn(a, b): the smaller stamp (absent contributes nothing)
joinRecord(A, B) = { life: joinLife, born: joinBorn, f[k]: (lww ? joinLww : ranked ? joinRanked : joinFww)(A.f[k], B.f[k]) }
```

- `fww`, `const` and `time` join by `joinFww`.
- `joinRanked` takes the maximum by `(rank(value), stamp, jcs(value))`, so a value never reverts to
  a lower rank, whatever the stamps.
- `joinLife` is today's add-biased element set (`platform/domain/Crdt.h`, `ElementSet`), for every
  type with life. Edge existence semantics are unchanged.

### §3.3 Laws

Each register join takes the maximum of a total order (for `ranked`, the order of
`(rank, stamp, jcs)`). The maximum of a total order is idempotent, commutative and associative,
with the absent register as identity, and `joinRecord` is their pointwise product. The lattice
fields of any set of applied deltas are therefore independent of admission order.

Text and serial fields are outside these laws. They are sequenced by the server's single admission
order (§6.1).

### §3.4 What clients join

A client never joins confirmed state. A server row replaces the confirmed row when its `seq` is
greater than or equal to the stored row's `seq`. Clients join only in the overlay views (§7.6) and
in coalescing (§7.2).

---

## §4 Identity rules

### §4.1 Shape and op

| Class | δ carries | Op |
|---|---|---|
| minted, derived | `life = [alive, born]` | `create` |
| | `life = [alive, s]`, `s ≠ born` | `revive` |
| | `life = [dead, s]` | `delete` |
| | no life | `update` |
| keyed with life | `life` | `put` (every write) |
| keyed without life, singleton | fields | `write` |

Any other shape is refused `invalid`.

### §4.2 Id state

`lock` reports the id state:
- `none`: no row and no `sync_spent` row for the id in the scope. For `idSpace: global`, none in any
  scope. For a governing type, no `sync_scopes` row for the governed scope.
- `foreign`: `idSpace: global` and the id exists or is spent in another scope; or, for a governing
  type, the governed scope exists and is not governed by this `(scope, type, id)`.
- `alive(b)`, `dead(b)`: alive or dead in this scope, with born `b`.

### §4.3 Decision table (minted and derived)

`=` means `b = δ.born` and `≠` means `b ≠ δ.born`. "ok" means `ok` with no change.

| Op | `none` | `foreign` | `alive =` | `alive ≠` | `dead =` | `dead ≠` |
|---|---|---|---|---|---|---|
| `create` | apply | `id-taken` | apply (join) | `id-taken` | ok | `id-spent` |
| `update` | `unknown-record` | `unknown-record` | apply | `unknown-record` | `record-dead` | `unknown-record` |
| `delete` | ok | ok | apply | ok | ok | ok |
| `revive` | `unknown-record` | `unknown-record` | apply | `unknown-record` | revivable: apply; else `id-spent` | `unknown-record` |

- A governing `create` that applies creates the governed scope. A governing `delete` that applies
  kills it (§6.1 step 15).
- Keyed with life: `put` applies on every state (a join on `alive` and `dead`).
- Keyed without life, and singleton: `write` applies (an implicit create on `none`).

### §4.4 Rules for every class

- **Client-origin deltas.** A delta that writes a `serial` field, or a `server` field, is refused
  `invalid`. So is a delta that writes a `const` or `time` field already set under a different
  stamp to a different value; an equal stamp is the same write and a no-op. Commands and
  server-origin writes MAY write any field.
- **Import intents** are single-record, except `gym.importSession` (C.7). An import intent refused
  `record-dead`, `id-spent`, `unknown-record` or `scope-dead` is answered `ok` with
  `detail: {dropped: code}`. Every other refusal is an ordinary refusal.
- **Spent ids.** No client mints an id that is alive, spent or pending in its views (§7.1). The
  server's own derived minting uses `taken` = the scope's alive and spent ids.

---

## §5 Invariants

**INV-1 Causal dominance.** A stamp minted by a replica, or by the server, after it observed a
server-sent stamp `s` is greater than `s`.

*Proof.* `observe(s)` raises the clock to at least `(s.ms, s.counter)`, and `tick` returns a strictly
greater pair (§10.2). Clients observe every row the server sends them, `hlcHigh` in every commit,
and a write map's stamps before they restamp the later entries that write the same registers
(§7.7). `clock-skew` recovery lowers the clock only to `max(physNow(), admittedHigh)`, which is at
least every server-sent stamp. The server observes, under the row lock, every register it
overwrites (§10.3).

**INV-2 No accidental resurrection.** A record that an admitted delete made dead is alive again only
through:
- an admitted `revive` of a revivable type; or
- for a keyed type, an admitted `put` whose life stamp exceeds the delete's.

*Proof.*
- **Minted and derived.** §4.3 answers a create onto `dead` with a no-op or `id-spent`. An update
  carries no life. Only `revive` sets alive.
- **Keyed.** A replayed put carries its original life stamp. The deleting replica had observed the
  record it deleted, so by INV-1 the delete out-stamps that put. A put that does not change presence
  carries the drawn life register unchanged (§7.1 step 4).
- **Dead state is retained.** Dead rows and `sync_spent` rows are kept for the scope's lifetime
  (§6.10). The `born` and `life_stamp` columns (§2.2) make every comparison exact.
- **Clients** push only intents (§7.4), replace rather than join confirmed rows (§3.4), and never
  mint a spent id (§4.4, §6.7).
- **Scope death** refuses every write (INV-13).

**INV-3 No silent loss.** While the replica's local store survives and the server's committed state
survives, every committed intent ends in exactly one outcome of D-15. An intent that ends `refused`
has a notice holding its content, written in the same local transaction. The one exception is an
import record dropped by §4.4.

Storage loss is outside this invariant: uninstall, cleared site data, private windows, and Safari's
deletion of script-writable storage after 7 days without interaction.
- Web engines MUST call `navigator.storage.persist()`.
- Signed-out product copy on web MUST NOT promise durability.

*Proof.*
- Entries leave the outbox only by §8.1.
- The sender retries each numbered intent until it has a result. Transport errors, 401, 503 and
  `retry` never end an intent (§7.4).
- The server stores one result per `(replica, n)`, in the transaction that sets `last_n` (§6.2).
  Poison ends in a stored `internal` result (§6.6).
- After a restore, acked entries return to `ready` (§7.5).
- A refusal folds its dependents into the same notice (§7.7).
- Coalescing joins registers of one record and one actor (§7.2).

**INV-4 At most once.** An intent from a replica, or a server-origin write that carries a
`requestId`, takes effect at most once.

*Proof.*
- `last_n`, the result and the effects commit in one transaction. A resend with `n ≤ last_n` returns
  the stored result. A missing or different digest for such an `n` answers `replica-forked` (§6.2).
- `sync_requests` is looked up under a lock before the intent is built (§6.3).

**INV-5 Feed completeness.** A replica that pulls a scope from cursor `c` until `more = false`
receives every record changed at a seq above `c`, in its state at that seq or later; or it receives
`reset`.

*Proof.*
- Seq is taken under the scope row lock, which is held to commit, so seq order is commit order
  (§6.1 steps 3 and 13).
- Pages are keyset scans over `(seq, type, id)`.
- A boot fixes `asOf`, and rows changed during the boot move above it and arrive in the live phase.
- A cursor of another epoch, or ahead of the scope's seq, gets `reset`.

**INV-6 Convergence.** Assume no new intents, every outbox empty, and every replica pulled to the
current seq. Then, for every scope a replica reads, its `drawn` view equals the server rows over
every lattice field, and its text and serial values equal the server's.

*Proof.*
- An empty outbox makes `drawn = confirmed` (§7.6).
- By INV-5 and replace semantics (§3.4), `confirmed` holds the server rows it was sent.
- Lattice fields are order-independent (§3.3). Text and serial have one authority.

**INV-7 No cross-account leakage.**
- (a) Rows reach only principals holding read access when each page or frame is sent (§6.7, §6.8).
- (b) Every write requires write access (§6.1 step 3).
- (c) A replica pushes only under its bound account, and a replica id bound elsewhere is refused
  (§6.2).
- (d) An entry of another account's lineage is never adopted, and sign-out purges the confirmed
  cache (§7.10).
- (e) Existence: for a principal without read access, an absent, private or dead scope answers
  `not-found` identically on push, pull, live and `roadmap.fork`, and a `foreign` id answers
  `id-taken` without its state. (Creating a governing record under a global id reveals that the id
  is in use, as `POST /v1/trees` does today.)
- (f) Visibility changes only through a guarded server command (A.1).

*Proof.* Each clause is enforced at its cited step. No other path emits rows or accepts writes.

**INV-8 Caps.** No admitted intent raises a type's alive count above its cap. A write that does not
raise the count is never refused by the cap. A client never composes an add that the server would
refuse only because a delete is held.

*Proof.* Counters live on the scope row and are updated under the scope lock, with the growth rule
(§6.5). The client checks against `stored`, which counts held deletes (§7.6).

**INV-9 Bounded poison.** An intent whose admission faults deterministically is attempted at most
`K_POISON` times, and the replica's later intents then proceed.

*Proof.* Faults are counted per `(replica, n, digest)` in a separate transaction, and at `K_POISON`
the result `internal` is stored and `last_n` advances (§6.6).

**INV-10 Hold durability.** A held gesture is sent iff Undo does not remove it before release and
the person does not discard it (§7.10). Process death and in-app navigation, including an activity
or scene recreation, never abandon it. The early releases, which end Undo, are leaving the app,
sign-in and sign-out (§7.3, §7.10). After process death, the next engine start releases it.

*Proof.*
- Held entries are durable rows, changed only by `release` and `undo` (§7.3).
- `undo` succeeds only while every entry of the gesture is held.
- Release runs in every replica state: at `releaseAt` by an in-process timer, on leaving the app, at
  engine start, and at sign-in and sign-out.

**INV-11 Product invariants.** Every invariant stated in Appendix A holds in every committed state.

*Proof.* Product checks and commands run inside the scope-locked admitting transaction (§6.1), and
database constraints back them up.

**INV-12 Merge keeps text.** The result of a text merge contains:
- every non-whitespace token that `head` or `mine` inserted or changed relative to the base;
- every non-whitespace base token that neither side deleted.

A result over the field's cap is refused `too-large`, and the notice holds `mine`.

*Proof.* Every diff3 region (§6.11) is stable, a one-sided change, or a conflict that emits both
changed sides.

**INV-13 Scope death is final.**

*Proof.* The only governing type is `tree`, which is minted and not revivable (§4.3). Overlays die in
the same transaction (D-5). Every write to a dead scope is refused, and every read answers `gone` or
`not-found`.

**INV-14 Bounded stamps.** The server never stores a stamp whose `ms` exceeds the server time at
which it is stored plus `MAX_SKEW_MS`, on any path. So a replica that observes stored stamps with a
correct offset never mints a stamp that §6.1 step 2 refuses, and `clock-skew` recovery terminates.

*Proof.*
- Client stamps are refused beyond the bound (§6.1 step 2).
- Server stamps are one tick after observing stored stamps, which are bounded by induction (§10.3).
- Migration clamps every stamp built from a legacy value (C.2).

**INV-15 Verified replica.** A replica whose cursor for a scope is live at seq N, without a key,
holds exactly the server's alive rows (§6.12) of the scope at N, or detects that it does not at its
next digest check (§7.5).

*Proof.*
- The server's scope digest at every committed seq is the sum over the scope's alive rows at that
  seq. It starts at 0, the transaction that changes a row changes it (§6.12), and migration
  computes it (C.6).
- A pull page reads its rows and its `(seq, digest)` in one snapshot (§6.7), and a live frame
  carries the digest committed with its seq, so a received `(N, d)` is the server's state at N.
- The client changes its digest in every transaction that changes its confirmed rows, hashing each
  row as received, so its digest is the sum over the rows it holds.
- A pull page that leaves the cursor live at the page's seq without a key triggers a check (§7.5),
  so every pull at N checks. Equal row sets give equal sums. Unequal sets give equal sums only if
  the hashes of their difference sum to 0 mod 2^256, with probability about 2^−256 for a
  difference not chosen to collide. The digest is a correctness check, not a security boundary: a
  replica checks its own cache against rows it may read.
- A detected mismatch resets the scope, and by INV-5 the boot delivers every alive row at its
  `asOf`. A mismatch right after such a reset is reported and not reset again (§7.5).

---

## §6 Server algorithms

Push, pull and server-origin admission MUST run on a worker pool that does not serve socket
or HTTP IO loops.

### §6.1 `admit(origin, intent) → Result`

These steps are an ordered, fail-fast pipeline. A refusal at any step goes to step R.

1. **Scope.** Map the reference to its key (`self` is the origin's account).
2. **Shape.**
   - Registered types for the scope kind; registered fields and command.
   - At least one delta or a command.
   - `idPattern`, bounds, units, domains and quanta.
   - §4.1, and §4.4's serial and server-field rules.

   Failure → `invalid`. A stamp with `ms > serverNow + MAX_SKEW_MS` → `clock-skew`. A `time`
   field or `time` argument beyond `serverNow + MAX_SKEW_MS` is clamped to `serverNow`. An
   `instant` argument beyond it → `invalid`.
3. **Lock and access.**
   1. Take the in-process mutex of the scope key with timeout `LOCK_TIMEOUT_MS`.
   2. `BEGIN`; `SET LOCAL lock_timeout`.
   3. An absent product scope, or an absent overlay scope whose `tree:<T>` is alive and readable
      by the origin, is inserted `alive`, with seq 0 and digest 0 (`INSERT … ON CONFLICT DO
      NOTHING`). Then `SELECT … FROM sync_scopes WHERE key = $1 FOR UPDATE`.
   4. Refuse:
      - `not-found`: absent; or the origin cannot read the scope; or dead and the origin is not its
        owner. An overlay answers as its tree does for the origin.
      - `scope-dead`: dead and the origin is its owner.
      - `forbidden`: readable but not writable, or a type's `origins` excludes the origin (for
        deltas outside a command), or a server-internal command from a replica.
4. **Server origin.** With a `requestId`, run §6.3's lookup, then build the deltas.
5. **Rows.** Call `lock` for every `(type, id)` that the deltas, guards and command touch.
6. **Identity.** Apply §4.3 to each delta, and §4.4's const and time rule against the locked
   row.
7. **Guards.** Each guard (D-19) must hold, else `stale` with detail `{t, id, field, current}`.
   A guard also holds when the stored register already carries the stamp this intent writes to it
   (a replay, for example after re-identify). A command's guards are not checked when its replay
   rule (Appendix A) resolves it as a replay.
8. **Command.** Run the handler (§6.4). Its deltas pass steps 5, 6 and 9–12.
9. **Product check.** `check` per type touched.
   - A create from a replica is re-checked like any write: `check` re-computes and validates every
     value the product's rules derive (Appendix A).
   - A create or update whose `parent` reference is not alive → `parent-dead`.
   - Appendix A rules may refuse with their codes, or append server deltas.
10. **Join.**
    - `after = joinRecord(before, δ)`.
    - Text fields are merged (§6.11).
    - Server stamps are minted (§10.3).
    - A joined row whose encoding exceeds `MAX_RECORD_BYTES` → `too-large`. Text bases do not
      count.
11. **Serial.** A new record without a serial value gets 1 plus the maximum over alive records
    sharing its `serialNext` fields, or 1 if there are none, in admission order (a command: in
    argument order). A value a command supplies is kept.
12. **Caps.** For each capped type, `after = counters[type] + net alive change`. Refuse `cap`
    (detail `{type, cap}`) iff `after > cap ∧ after > counters[type]`.
13. **Apply.** If any row changed:
    1. `seq := ++scope.seq`.
    2. Update the counters.
    3. `apply(seq, changes)`.
    4. `sync_spent` gains a row per record that newly died under `deadRows: spent`, and loses the
       row of a keyed record that became alive.
    5. `rc := serverNow` on rows that did not exist; `ru := serverNow` on every changed row.
    6. The scope digest takes every changed row (§6.12).
14. **Command scopes.** Writes into a scope the same intent creates (fork) are applied after step 15
    creates it, and take that scope's seq and digest.
15. **Lifecycle.**
    - A governing create inserts `sync_scopes(tree:<id>, alive, seq 0, digest 0)`.
    - A governing death marks `tree:<id>` and every `acct:*/overlay/<id>` dead, with `dead_at`.
    - An overlay row stores `governed_by = tree:<id>`. Scope rows are locked in this order: the
      intent's scope, `tree:<id>`, then overlays in ascending key order.
16. **Result.** `ok {seq: scope.seq, write?, detail?}`, where `write` is a command's write map.
    - Replica origin: upsert `sync_results(replica, n, digest, result)` and set `last_n := n`.
    - Server origin with a `requestId`: insert `sync_requests`.
17. **`COMMIT`.** Release the mutex, and send live frames (§6.8).

**Step R.**
1. `ROLLBACK`.
2. Apply §4.4's import rule.
3. In a new transaction, write the result and `last_n` as step 16 does.

**Exceptions** are classified by §6.6.

### §6.2 Push

`POST /v1/sync/push` (§9.3):

1. **Authenticate.** Failure → `401`.
2. **Epoch.** The response carries the current epoch.
3. **Bind.** An absent `sync_replicas[replica]` is inserted with `last_n = 0`. A replica bound to
   another account → `409 replica-foreign`.
4. **Take intents in ascending `n`:**
   - `n ≤ last_n`: no stored row, or a digest ≠ `digest(intent)` → `409 replica-forked` (stop).
     Otherwise answer the stored result.
   - `n > last_n + 1` → `409 gap` (stop).
   - Otherwise `admit`.
5. **Bound the work.** After `PUSH_WORK_MS`, stop and return `retry {n, retryAfterMs: 0}` naming the
   first unprocessed intent.
6. **Prune.** Delete this replica's `sync_results` rows with `n ≤ ackThrough`.

`digest(intent) = sha256(jcs(intent))`. A client never resends an `n` whose result it recorded, so
a missing row for `n ≤ last_n` means the store was forked or restored.

### §6.3 Server-origin writes

MCP tools, REST writes, tending and server-internal commands call
`admit(server(A, requestId?), intent)`.

- **With a `requestId`,** dedupe is per tool call, with `digest = sha256(jcs({tool, args}))`.
  1. Every admit of the call takes `pg_advisory_xact_lock(A, requestId)` and sets
     `started_at := now`. Before its first intent the call looks up `sync_requests(A, requestId)`:
     a final result with the same digest → return it; a different digest → `request-conflict`;
     `running` younger than `REQUEST_LEASE_MS` → `request-running` (retry later); `running` older
     than that → the lookup's transaction takes the lease over (`started_at := now`) and the call
     resumes from the stored `requestId#k` results (step 2). The first admit's transaction stores
     the row as `running`.
  2. The tool's k-th admit stores its result under `requestId#k` in its own transaction, including
     every output a later admit needs (such as a minted tree id). Every admit, original or retry,
     skips when its `requestId#k` exists, with the same digest; a retry rebuilds later admits from
     those outputs.
  3. The call's final result replaces `running` with its last admit. An admit that faults (§6.6)
     replaces `running` with its fault result.
  4. Every intent of one call carries the same `gestureId`: the `requestId`, or a server-minted id.
- **Without a `requestId`:** no deduplication.
- **Builders** that read the graph (`tidy`, `prune`, `recolor`, sibling order, derived ids) read
  under the scope lock, from rows or from a cache whose seq equals `scope.seq`.
- **Server-built imports** classify each incoming id as create, update or spent before building
  deltas, and report spent ids to the caller.

### §6.4 Commands

`handler(txn, ctx, args) → {deltas, write, detail} | refuse(code)`:
- It is deterministic given the locked rows, `args` and `serverNow`.
- It MAY lock more rows through the ports, and MAY write any field.
- It resolves its own replays (Appendix A), comparing the raw arguments stored with its receipt.
- A command not in Appendix A is refused `invalid`.

### §6.5 Caps

`sync_scopes.counters[type]` equals the number of alive records of the type in the scope. It is
computed at scope creation or migration and changed only in step 13. The cap check reads the counter
and never counts rows.

### §6.6 Faults and poison

- **Transient:** connection failure, pool exhaustion, a mutex or `lock_timeout` timeout,
  serialization failure, deadlock or shutdown. Roll back, record nothing, stop the request, and
  return the results so far with `retry {n, retryAfterMs}`.
- **Fault:** any other exception, including `statement_timeout`.
  1. Roll back.
  2. In a new transaction, upsert `sync_results(replica, n, digest, null, faults + 1)`.
  3. At `faults ≥ K_POISON`, store `refused internal` and set `last_n := n`.
  4. Otherwise stop the request with `retry`.
- Server-origin faults return to their caller.

### §6.7 Pull

`POST /v1/sync/pull` (§9.4). Each requested scope is served from one read-only `REPEATABLE READ`
transaction, so its access check, its rows (`feed` and `sync_spent` alike), its `seq` and its scope
digest all come from one snapshot:

1. **Access**, as §6.1 step 3, without creating a scope. An absent product scope, or an absent
   overlay of a readable alive tree, answers an empty live page at seq 0 with digest 0.
   - `not-found`: absent; or no read access; or dead, to a non-owner.
   - `gone`: dead, to its owner.
2. **Reset.** `cursor.epoch ≠ epoch` or `cursor.seq > scope.seq` → `reset`. `cursor = null` →
   boot with `asOf := scope.seq`.
3. **Boot page.**
   - Rows with `seq ≤ asOf` and `(seq, type, id) > (cursor.seq, cursor.key)`, in that order, from
     every type's `feed` merged with `sync_spent`, both read in the snapshot.
   - Keep a row iff it has no life, it is alive, or its type is `derived`. A dead derived row is
     sent thin: `{t, id, life, born}`.
   - Up to `PULL_PAGE_BYTES`, with at least one row. When the scan is exhausted the cursor becomes
     `{live, seq: asOf}`.
   - The page carries `total`: the rows with `seq ≤ asOf` that the boot keeps, counted in the
     snapshot, for progress. It can fall between pages, as rows move above `asOf`.
4. **Live page.**
   - Every row with `(seq, type, id) > (cursor.seq, cursor.key)`. Dead rows are thin (`{t, id,
     life, born}`).
   - The cursor becomes `{live, last seq}`, plus the last key when the page ends inside a seq.
5. **Head.** A rows page carries the scope's `seq` and scope digest (§6.12) as the snapshot holds
   them, so they describe exactly the state its rows come from.
6. **Header.** A `tree:<T>` page carries `header = {owner: {name}}`.

Before a `self/gym` pull is served, `gym.closeStale` runs (A.2) in its own admission, which commits
before the pull's snapshot is taken.

### §6.8 Live push

After step 17, the server sends `{op: change, scope, epoch, seq, digest, rows}` at once, with no
debounce, to every socket subscribed to the scope that still holds read access. `digest` is the
scope digest committed with `seq`.
- `rows` is omitted above `LIVE_INLINE_BYTES`.
- A scope that dies sends `gone` to its owner and `not-found` to other subscribers.
- A visibility change that removes a subscriber's access sends `not-found` and ends that
  subscription.
- The per-socket access check MUST use in-memory state, invalidated by `roadmap.setVisibility` and
  by scope death.
- A deployment with several server processes MUST relay committed changes to every process holding
  subscribers.

### §6.9 Projections and read caches

`apply` MAY write derived rows in the admitting transaction. Appendix A lists them. A read cache
MUST be keyed by `(scope, seq)` and MUST NOT answer an admission.

### §6.10 Retention and GC

- **G1.** A non-revivable record that dies loses its fields. Its row is deleted (`deadRows: spent`,
  with `sync_spent` keeping it) or thinned (`deadRows: keep`). Revivable dead rows keep their
  fields.
- **G2.** Dead rows and `sync_spent` rows are kept for the scope's lifetime.
- **G3.** `sync_results` rows are deleted at `ackThrough` (§6.2). A replica unseen for `REPLICA_GC`
  is deleted with its results.
- **G4.** `sync_requests` rows whose `started_at` is older than `REQUEST_RETENTION` are deleted.
- **G5.** A scope dead for `SCOPE_HORIZON` loses its typed rows and `sync_spent` rows. Its
  `sync_scopes` row stays, with digest 0.
- **G6.** Text revisions follow Appendix A.

### §6.11 Text merge

A text delta is `{text, base}`, where `base` is `{rev}` (a head revision of the field) or `{text}`.
Let `head` be the stored text.

1. **Base.**
   - `{rev}` equal to the field's rev → `head`.
   - Otherwise `revisionText(rev)`; if absent → `base-unknown`.
   - `{text}` → that text. An empty base text becomes `head` when `mine` extends `head`, and
     `mine` when `head` extends `mine` (`x` extends `y` when `y`'s tokens are a prefix of `x`'s).
2. **Merge.**
   - `mine = head` → `head`.
   - Else `base = head` → `mine`.
   - Else `base = mine` → `head`.
   - Else → `diff3(base, head, mine)`.
3. **Cap.** A result over `max` → `too-large`.
4. **Store.** The previous head goes to the revision table under its rev; the new rev is this
   intent's seq. `merged := conflict ∨ (merged ∧ baseText ≠ headText)`, where `conflict` means a
   region emitted both sides.

`diff3(base, head, mine)`:
- **Tokens:** maximal runs of whitespace (ECMAScript `\s`) and of non-whitespace.
- **Diffs:** `base→head` and `base→mine` are shortest edit scripts (Myers). Ties prefer a deletion
  before an insertion, earliest position first.
- **Walk `base`:**
  - a stable token is emitted once;
  - a region changed on one side emits that side;
  - overlapping or adjacent regions changed on both sides form a conflict: equal replacements are
    emitted once; if one replacement is empty, the other is emitted; otherwise emit
    `rtrim(H) + "\n\n" + ltrim(M)`, trimming whitespace.

### §6.12 Scope digest

A row is **alive** here when its life is absent or alive. An alive row `r` hashes to
`h(r) = sha256(utf8(jcs(r)))`, read as an unsigned 256-bit big-endian integer. `r` is the §9.1
`Row` exactly as a page carries it:
- `t`, `id`, `seq`, `rc` and `ru`, always;
- `life` and `born`, iff the record has them;
- `f` iff the record has a lattice register, holding each as `[value, stamp]`;
- `x` iff it has a text value, holding each as `{text, rev, merged}` with the whole text;
- `v` iff it has a serial value.

A client stores and hashes the fields and types it does not know (§7.6). Dead rows, a page's
`header`, text bases and revisions, and `SpentId` rows are outside the digest. A client missing a
spent id is answered `id-spent` if it mints that id (§4.3).

The **scope digest** is `Σ h(r) mod 2^256` over the scope's alive rows. An empty or absent scope
has digest 0. The server stores it as 32 big-endian bytes; the wire carries it as 64 lowercase
hexadecimal characters. Every alive row counts, since a client holds each scope it subscribes in
full (§7.9).

**Server.** In the transaction that changes the rows, under the scope lock, each changed row applies
`digest := digest − h(before) + h(after) mod 2^256`, with `h = 0` for an absent or non-alive row and
`after` taken once its seq, `rc` and `ru` are set (§6.1 step 13). `feed` MUST return every row
exactly as `apply` stored its `after`, so the server hashes the form a page carries. Every row
change is such a transaction: replica and server-origin admission, every command (`gym.closeStale`
included), and a fork's writes into its new scope (§6.1 step 14). Every referential consequence
(§2.2) is a change of step 13, and a derived row that `apply` writes (§6.9) is never a `feed` row. A
governing create starts its scope at digest 0. Scope death changes no row, and a dead scope's digest
is never sent; G5 sets it to 0. Migration computes it (C.6), and a restore brings it back with its
rows. A pull reads the stored digest and never sums rows.

**Client.** The client keeps the same sum over its confirmed rows, hashing each row as received,
and checks it against the server's (§7.5). It MAY store each row's hash beside the row. Pending
entries and predictions never enter it.

---

## §7 Client algorithms

### §7.1 `commit(scope, changes, opts) → LocalId[] | Refused`

`opts = {atomic, hold, guard, cmd, predict, local, gestureId}`. `commit` is a synchronous call on
the local store. It MUST NOT be launched from a cancellable UI scope, and never awaits the network.
One local transaction:

1. **Writable replica.** The replica is `anon` or `bound`; otherwise throw.
2. **Scope check.** For `tree/<T>` and `self/overlay/<T>`: if the `tree` record `T` is dead in
   `stored`, or the scope is known `gone` or `not-found`, return `Refused(scope-dead)` and write
   nothing.
3. **Stamp.** Read `meta.hlc`, `observe(hlcHigh)`, `s := tick()`, and write `meta.hlc` back.
4. **Deltas.** Diff `changes` against `drawn`, emitting only changed fields, stamped `s`:
   - A minted or derived delta carries the record's `born`. A create gets `born = s` and
     `life = [alive, s]`.
   - A create of an id already in `drawn` is dropped.
   - A keyed-with-life put's life:
     - `[alive, s]` when the gesture makes the record present;
     - `[dead, s]` when it removes it;
     - otherwise the drawn life register, unchanged.
   - A revive takes `born` from `drawn` or from `SpentId`.
   - An update or delete of a record absent from `drawn` throws.
   - `time` values come from `physNow()` unless the change supplies them.
   - Values are rounded to the field's `quantum`, half away from zero.
   - A text change names the text it was edited from. The entry keeps that text in `baseTexts`.
     The delta's base is `{rev}` when that text is the confirmed text at that rev; otherwise
     `{text}`.
5. **Ids.** Minted ids come from a CSPRNG, or are seeded (D-8). Label-based derived ids come from
   `derive` (D-26).
6. **Guards.** With `guard`, add `(t, id, field, stamp from stored)` for every field written, and
   for every register `guard` names that the gesture read.
7. **Group.** `atomic`, `hold` or `cmd` → one intent; otherwise one intent per record.
8. **Size.** An intent whose encoding exceeds `PUSH_MAX_BYTES` is not enqueued. Return
   `Refused(too-large)` and write a notice.
9. **Enqueue.** Each entry takes lineage A in a `bound(A)` replica, and `anon` in the `anon` replica
   (D-27).
   - `hold` → `held` with `releaseAt = deviceNow + HOLD_MS`.
   - Otherwise `ready`, coalesced when §7.2 allows.
10. **Device rows.** Write `opts.local` rows into `device/<product>`. A commit with only local rows
    is legal.
11. `hlcHigh := s`.

After the commit: notify tabs (§7.8), kick the sender, and schedule release timers.

### §7.2 Coalesce

A new ready plain intent `I` on `(t, id)` joins the last outbox entry `E` touching `(t, id)` iff:
- `E` is ready and plain;
- no command entry of the scope lies between `E` and `I`;
- for text fields, `E` and `I` carry the same stamp actor (one engine instance).

```
E.delta := joinRecord(E.delta, I.delta)        // text: E keeps its base and baseTexts; takes I's text
if E.delta has born and E.delta.life = [dead, _]: remove E    // created and deleted unsent
I ends 'coalesced'
```

### §7.3 Hold, release, undo

```
release(entry): tx: if entry.state = held → state := ready; coalesce per §7.2; kick the sender
undo(gestureId): tx: if every entry of the gesture is held → delete them, return true; else return false
```

- Release runs in every replica state.
- **Triggers:**
  - an in-process timer at `releaseAt`, owned by the app or process (on web, a timer in every tab);
  - **leaving the app** releases every held entry into the durable queue at once, and the sender
    attempts a best-effort flush. Leaving is the process- or scene-level signal: Android
    `ProcessLifecycleOwner` `ON_STOP`, iOS scene `.background` of the last foreground scene, and on
    web no tab of the app visible, debounced, or the last tab's `pagehide`. A tab that becomes
    hidden decides after `LEAVE_DEBOUNCE_MS`, and leaves only if no tab has announced it is visible
    by then (§7.8). A page suspended before `LEAVE_DEBOUNCE_MS` elapses releases on its next resume
    or `pagehide`; the hold is durable either way. The last tab's `pagehide` SHOULD number the ready entries and push them with
    `fetch(keepalive)`, up to `KEEPALIVE_BYTES`. A reload is a `pagehide`;
  - engine start releases every held entry, with no Undo shown: on iOS and Android the process's
    start, on web the first tab's (§7.8);
  - sign-in and sign-out release every held entry into the durable queue (§7.10).
- Undo is offered from held entries with `releaseAt > deviceNow` while the app stays in the
  foreground. It is not offered again after leaving. An activity or scene recreation inside the app
  (a dark-mode switch, a rotation) is not leaving: the Undo transient is redrawn with its remaining
  time.
- No background timer, job or task keeps a hold. A released entry is sent like any ready entry, by
  the flush or by a later sender run.

### §7.4 Sender (one per replica: the web leader tab, or an app-scoped worker)

```
loop while state = bound ∧ ¬authPaused ∧ online:
  tx: number ready entries in commitOrder, up to PUSH_MAX_INTENTS / PUSH_MAX_BYTES,
      stopping after the first command entry: n := nextN++, digest, state := sent
          (no entry is numbered while a command entry is `sent`)
  POST push { replica, ackThrough, intents: sent entries by n }
  network error | 503           → backoff
  retry {n, retryAfterMs}       → entries from n stay sent (unless §7.7 step 1.3 returned them to
                                  ready: it takes precedence); wait, then continue
  401                           → authPaused := true (no retry consumed)
  426                           → stop until upgraded
  400 or 413, one intent        → that entry ends refused (invalid | too-large), with a notice
  413, several intents          → halve the batch
  replica-forked | replica-foreign | gap → re-identify (§7.11)
  per result, in its own tx:
    ok      → acked, resultSeq := seq, resultEpoch := the response epoch; apply the write map (§7.7)
    refused → §7.7
    ackThrough := the response's lastN, once its results are recorded
  then, if the response epoch ≠ serverEpoch → epoch change (§7.5)
backoff: sleep random(0, min(ceiling, 1 s · 2^k)); ceiling = liveHint ? 30 s : 300 s; k resets on any result
kick (wake now, k := 0): commit, release, connectivity change, foreground, auth refresh
```

### §7.5 Puller, reset and epoch change

The puller runs on start, foreground, reconnect, a live gap, and every `PULL_FALLBACK_MS`. It pulls
each subscribed scope until `more = false`.

1. Update the offset (§10.4) before observing any stamp. A null `serverEpoch` takes the response
   epoch. A response epoch ≠ a non-null `serverEpoch` triggers an **epoch change** first. In one
   transaction:
   1. `serverEpoch := epoch`.
   2. Every cursor becomes `null`.
   3. Every `acked` entry with `resultEpoch ≠ epoch` returns to `ready` at its commit position.
   4. Re-identify (§7.11).

   A restore is outside INV-3's condition. For example, a re-sent `gym.start` may create its
   session again under a new `born`, and a pending delete already rewritten to the old `born`
   then ends as a no-op; and a notice may describe a record that a forked store later re-creates.
2. Per page, in one local transaction:
   - **Stale page.** A page requested with a cursor other than the scope's stored cursor is dropped,
     and the scope is pulled again, so a cursor never moves backwards.
   - **`reset`:** the cursor becomes `null`.
   - **Boot rows** go to staging when confirmed rows exist, otherwise straight in. A thin dead
     derived row adds a `SpentId`. On `more = false`:
     - staging replaces the scope's confirmed rows, and its digest replaces theirs;
     - `booted := true` once the cursor is live;
     - acked entries of the scope with `resultEpoch = serverEpoch` and `resultSeq ≤ asOf` resolve.
   - **Live rows** replace confirmed rows by §3.4; a dead row deletes it, and a dead derived row
     also adds a `SpentId`.
   - **`gone` or `not-found`:**
     - delete the scope's confirmed rows, `SpentId` rows and cursor, and unsubscribe;
     - acked entries of the scope resolve;
     - pending entries stay, and the server refuses them.
   - Every change to the scope's confirmed rows changes `CursorRec.digest`, and every change to its
     staging changes the staging digest (§6.12).
   - Store the cursor, observe every stamp, update `admittedHigh`.
   - Resolve acked entries whose `resultSeq ≤ cleanSeq` in the same epoch.
     - Live cursor: `cleanSeq = cursor.seq`, or `cursor.seq − 1` while the cursor carries a key.
     - While booting: `cleanSeq = −∞`.
3. **Live frames.** A `change` frame is applied as a live page iff the cursor is live without a key,
   `epoch` matches, `seq = cursor.seq + 1`, and `rows` is present. Otherwise pull.
4. **Digest check.** When, after a page or frame is applied, the cursor is live, carries no key and
   its seq equals the page's or frame's `seq`, and no staging is pending, the client compares its
   digest with the received one, in that transaction. This covers a live page that reaches the head,
   a frame applied inline, and a boot whose `asOf` scan has ended and caught up to the head. On a
   mismatch:
   1. emit the telemetry event `sync-digest-mismatch`, with the scope kind and seq and no row
      content;
   2. reset the scope: the cursor becomes `null`, and the next pull boots it into staging (step 2).
      The outbox is untouched.

   When the first check after such a reset mismatches too, the client emits the event once more and
   stops checking that scope, recording the app version in `CursorRec.digestStop`; checks resume
   when the app version changes.

### §7.6 Views

```
pending(scope, withHeld) = entries of scope in {ready, sent, acked} ∪ (withHeld ? {held} : {}), in commitOrder
drawn(t, id)  = fold(joinRecord, confirmed[t, id], [e.delta[t, id] ∪ e.predict[t, id] for e in pending(scope, true)])
stored(t, id) = the same fold over pending(scope, false)
text fields: the newest pending text replaces the confirmed text
visible(r) = singleton ∨ (life ? r.life = alive : visibleWhen (§2.4))
capCount(t) = |{ id : visible(stored(t, id)) }|
```

- `drawn` decides what is drawn.
- `stored` decides caps, guards and write positions (D-25's drop position), so a held delete still
  occupies its slot.
- Serial values come only from confirmed rows.
- Unknown fields, and rows of unknown types, are preserved and ignored.
- Appendix A may add a product view rule (the gym stale rule).

### §7.7 Refusal, rebase, recovery and maps

On `refused(code)` for entry `e`, in one local transaction:

1. **Automatic recovery,** which writes no notice. `e` returns to `ready` at its commit position:
   - `clock-skew`:
     1. Update the offset.
     2. `hlc := max(physNow(), admittedHigh)`.
     3. Every later `sent` entry with `n` above the response's `lastN` returns to `ready`, and
        `nextN := lastN + 1` (the server never processed those numbers).
     4. Restamp `e`, and every held and ready entry, in commit order, by the restamp rule below
        (import intents other than `e` excepted: their stamps are migration facts, which C.2 keeps
        at or below `M`).
     5. `meta.hlc` and `hlcHigh` become `max(admittedHigh, the new stamps)`, shared by every tab.
   - `base-unknown`: every text delta of `e` switches to `base: {text: baseTexts[…]}`.
2. **Remove `e`.**
3. **Fold dependents.** A dependent is a delta of a later entry that touches, or whose `ref`
   fields or `ref` arguments name, a record created in `e` (by a delta or by `predict`), or that
   targets a scope whose governing record `e` creates.
   - Dependents are removed, and entries left empty are dropped.
   - A dependent entry already `sent` is marked `orphanOf = e`. Its later result ends it without
     a notice: `ok` → `resolved`, a refusal → `refused`.
4. **Notice.** Write a notice with `e`'s content and the dependents' content.
5. **Redraw.** Recompute the touched views. This is the whole rebase; clients re-execute no
   business logic.

**Write map.** An `ok` result's write map applies in the result's transaction. Let `s` be the
command entry's stamp, which every register it predicted carries. For each entry `w`:
1. `w.from` is present only when the resolved id differs from the id the command was called with,
   which means the record existed before the command (a join). It is replaced by `w.id` in every
   held and ready entry (delta ids, `ref<w.t>` fields and arguments), in `predict`, and in device
   rows (a product hook). The exception is an entry whose delta deletes `(w.t, w.from)`: it is not
   rewritten, and ends `refused` with `target-merged` and a notice.
2. The command's own `predict` is restamped by the restamp rule, with `n` given by the map:
   `w.f[f]` for each field, and `w.born` for the life of a record it created or resolved to. Later
   borns and guards naming the stamps its predicted registers carry follow. The predict stays
   drawn until the cursor covers `resultSeq`.
3. The client observes every stamp in the map. Then it restamps, by the restamp rule with fresh
   ticks, the registers the map names (a field in `w.f`, or the life of a `w` with `born`) in every
   held or ready entry that writes them. A later local write therefore follows the command it came
   after (INV-1).

No entry is `sent` behind a command (§7.4), so every reference, born and guard is rewritable.

**Restamp rule.** Used by `clock-skew` recovery (every register of an entry) and by the write map
(steps 2 and 3). Each restamped entry takes one new stamp `n`: a fresh tick in commit order, or the
stamp a write map gives. For each register that moves from `o` to `n`:
1. the register takes `n`;
2. if it is a create's life, the entry's `born` also becomes `n`, and every later held or ready
   delta on the same `(t, id)` carrying `born = o` takes `n`;
3. every later held or ready guard on that register naming `o` takes `n`.

### §7.8 Multi-tab (web)

- The leader holds `navigator.locks` lock `wm-sync:<replica>` and runs the sender, the puller and
  the live socket.
- A tab requests the lock when it becomes visible. A hidden tab releases it once a peer announces
  it is visible.
- Tabs post `hello {visible}`, `visible`, `hidden`, `bye` and `changed(scope, ids)` on
  `BroadcastChannel('wm-sync:<replica>')`, and a tab answers a peer's `hello` with its own. A tab
  that knows no other live tab is the last tab.
- Every tab holds the lock `wm-tab` in shared mode while it lives. A tab that finds it unheld
  (`navigator.locks.query()`) when it starts is the first tab.
- Every tab reads views from IndexedDB and commits through §7.1.

### §7.9 Subscriptions

A bound replica subscribes the product scopes of the products its surface carries (Appendix A), and
no scope of another product. For roadmap it also subscribes `tree/<T>` and `self/overlay/<T>` for
every alive `tree` and `track` record, and any `tree/<T>` while it is open. An `anon` replica pulls
only readable trees it opens. Every scope a replica pulls is held in full: a boot sends every alive
row (§6.7). The engine exposes `firstPullComplete(scope)`: `CursorRec.booted` for a scope the
replica pulls, and true for a scope it does not pull (an `anon` replica pulls no product scope).

### §7.10 Replica lifecycle

**Sign-in as A** follows the lineage rule (D-27), per product. It runs after a successful hello as
A, which states the products in which A holds records (§9.2). An entry's product is its scope's;
tree and overlay scopes are roadmap's. It first releases every held entry into the durable queue
(Undo does not survive sign-in), before the decisions.
- Entries of lineage A, a `dormant(A)` replica's included, are sent without asking.
- Entries of the `anon` replica are added to A without asking for each product in which A holds no
  records, whatever `unattributed` entries exist.
- Two kinds of decision are due per product and sign-in, each an explicit add or discard, with no
  default and no "later":
  - **signed-out:** due iff A holds records in the product and the `anon` replica has entries of
    it; it covers exactly those entries;
  - **owner-unknown:** due iff an `unattributed` replica has entries of the product, whatever A
    holds; it covers exactly those entries.

  A decision covers its entries of every type (in gym, `thread` and `message` too). The engine
  exposes `anonCount(product, kind)` per decision: the count, by type, of the records its entries
  create or change. How the decisions are presented is product canon. Until every due decision is
  made the sign-in is not complete: the `anon` replica stays active, no replica changes and nothing
  is sent. Cancelling an incomplete sign-in changes nothing more; it resumes, with a new hello and
  every decision still due, at the next engine start.
- **Adoption boundary:** entries of another account's lineage are never adopted. A `dormant(B)`
  replica stays dormant.

Then, in one local transaction:
1. **Discard.** For each decision answered discard, the entries it covers end `discarded`, deletes
   released at the start among them, and the product's device rows in the replicas those entries
   come from are deleted.
2. **Bind.** A `dormant(A)` replica becomes `bound(A)`, with every cursor `null`. Otherwise the
   `anon` replica, when entries are left in it, is rebound (`state := bound`, `account := A`).
   Otherwise a new `bound(A)` replica is created.
3. **Add.** Every other `anon` or `unattributed` replica with entries left moves them, and its
   device rows, into `bound(A)`, preserving local ids, gesture ids, stamps and commit order, and
   is then deleted. A moved device row whose key `bound(A)` already holds is dropped. An
   `unattributed` replica left empty is deleted.
4. Every entry added to A, rebound or moved, takes lineage A, and `bound(A)` observes its stamps
   into `hlc` and `hlcHigh`.

While A is bound, migration that creates an `anon` or `unattributed` replica with entries (C.7)
runs the same rule on them: the decisions where they are due, then steps 1, 3 and 4.

**Other transitions:**
- **Sign-out of A:**
  1. Every held entry is released into the durable queue (Undo does not survive sign-out), and the
     sender attempts to flush the outbox.
  2. If entries remain, the product's sign-out confirmation MUST state their count (the engine
     exposes `unsentCount(replica)`) and offer Keep or Discard.
  3. With none left, or on Keep: delete A's confirmed rows, `SpentId` rows, cursors and device
     rows, and set `state := dormant`; remaining entries are sent on the next sign-in as A. On
     Discard: delete the replica, and its entries end `discarded`.
  4. The `anon` replica, created if absent, becomes the active one.
- **Discard unsent** (explicit, for `dormant` and `unattributed`): delete the replica. Its entries
  end `discarded`.
- **Account change:** signing in as another account while A is `authPaused` is a sign-out of A,
  then a sign-in.

### §7.11 Fork guard and re-identify

At engine start (iOS and Android), a `forkGuard` that differs from the backup-excluded copy, or a
missing copy, triggers **re-identify**. In one local transaction:
1. Mint a new replica id and `forkGuard`.
2. `nextN := 1`, and `ackThrough := 0`.
3. Every `sent` entry returns to `ready`. The sender numbers them again in commit order, with new
   digests.

---

## §8 State machines

### §8.1 Intent

| From | Event | To |
|---|---|---|
| — | `commit` with hold / without hold | `held` / `ready` or `coalesced` |
| — | `commit` over `PUSH_MAX_BYTES` | not enqueued (notice) |
| `held` | release (§7.3): `releaseAt` reached, leaving the app, engine start, sign-in or sign-out | `ready` |
| `held` | `undo` | `undone` |
| `ready` | numbered | `sent` |
| `ready` | create and delete cancel (§7.2) | `coalesced` |
| `held`, `ready` | folded as a dependent | `refused` (in the dependency's notice) |
| `held`, `ready` | a write map merges its delete target into an existing record (§7.7) | `refused` (`target-merged`, a notice) |
| `sent` | `ok` | `acked` |
| `sent` | `clock-skew`, `base-unknown` | `ready` (recovered, same position) |
| `sent` | another refusal; 400 or 413 on a one-intent request | `refused` (a notice, or none for an orphan) |
| `sent` | orphan receives `ok` | `resolved` |
| `sent` | transport error, 401, 503, `retry` | `sent` |
| `sent` | re-identify (fork guard, `replica-forked`, `replica-foreign`, `gap`, epoch change) | `ready` |
| `sent`, unprocessed | an earlier entry's `clock-skew` recovery (§7.7 step 1) | `ready` (restamped) |
| `acked` | `cleanSeq ≥ resultSeq` in the same epoch; boot complete with `asOf ≥ resultSeq`; scope `gone`, `not-found` or unsubscribed | `resolved` |
| `acked` | epoch change, when `resultEpoch ≠ epoch` | `ready` |
| any non-terminal | discarded by the person (§7.10) | `discarded` |

### §8.2 Replica

| From | Event | To |
|---|---|---|
| — | first launch | `anon` |
| — | migration finds owner-less data | `unattributed` |
| — | sign-in as A, no `dormant(A)` and no rebound `anon` replica | `bound(A)` (new) |
| `dormant(A)` | sign-in as A | `bound(A)` |
| `dormant(B)` | sign-in as A | `dormant(B)` |
| `anon`, entries left after discards (§7.10) | sign-in as A, no `dormant(A)` | `bound(A)` (rebound) |
| `anon`, entries left after discards | sign-in as A with a `dormant(A)`; migration while `bound(A)` | deleted (entries moved to `bound(A)`) |
| `anon`, no entries left | sign-in; migration while bound | `anon` |
| `unattributed` | sign-in as A; migration while `bound(A)` | deleted (entries moved to `bound(A)` or discarded, by each owner-unknown decision) |
| `anon`, `unattributed` | sign-in as A with a decision still due, or cancelled | unchanged; nothing sent (§7.10) |
| `bound(A)` | sign-out, empty outbox or Keep | `dormant(A)` |
| `bound(A)` | sign-out, Discard | deleted |
| `bound(A)` | 401 / re-authentication as A | `authPaused` set / cleared |
| `dormant`, `unattributed` | explicit discard | deleted |
| any | fork guard, `replica-forked`, `replica-foreign`, `gap`, epoch change | same state, new replica id |

### §8.3 Scope

| From | Event | To |
|---|---|---|
| `absent` | first write (product scope; overlay of a readable alive tree) | `alive` |
| `absent` | governing `tree` create | `alive` |
| `alive` | governing `tree` delete | `dead` (tree scope and every overlay of it) |
| `dead` | `SCOPE_HORIZON` elapsed | `dead`, rows removed |

Client cursor: none → boot (subscribe, `reset`, or a digest mismatch, §7.5) → live (last boot
page) → none (`gone` or `not-found`).

---

## §9 Wire protocol

### §9.1 Encodings

JSON over HTTPS and WebSocket. Every response carries `serverTime` and `epoch`. Every request carries
the header `Sync-Schema` with the registry version. Keyed ids declared as arrays (`edge: [from,
to]`) have their `jcs` as identity.

```ts
type Life = ['alive'|'dead', Stamp]
type Reg = [Json, Stamp]
type Row = { t, id, life?: Life, born?: Stamp, f?: Record<string, Reg>,
             x?: Record<string, {text: string, rev: number, merged: boolean}>, v?: Record<string, Json>,
             seq: number, rc: number, ru: number }
type Delta = { t, id, life?: Life, born?: Stamp, f?: Record<string, Reg>,
               x?: Record<string, {text: string, base: {rev: number} | {text: string}}> }
type Guard = { t, id, field: string, stamp: Stamp | null }
type Cmd = { name: string, args: Json }
type Intent = { n: number, scope: ScopeRef, d?: Delta[], guard?: Guard[], cmd?: Cmd,
                gestureId?: string, import?: true }
```

### §9.2 Hello: `GET /v1/sync/hello`

```ts
→ { serverTime, epoch, schema: number, minSchema: number,
    migratedAt: { roadmap?: number, journal?: number, gym?: number },
    products: { roadmap: 'engine'|'legacy', journal: 'engine'|'legacy', gym: 'engine'|'legacy' },
    holdsRecords?: { roadmap: boolean, journal: boolean, gym: boolean } }   // authenticated callers
```

`holdsRecords` is present iff the caller is authenticated as an account A. `holdsRecords[p]` is true
iff `acct:A/<p>` holds a row that `visible` (§7.6) accepts, of a `primary` type (§2.4). A
sign-in's lineage rule uses the hello that precedes it (§7.10).

### §9.3 Push: `POST /v1/sync/push`

```ts
type PushRequest = { replica: string, ackThrough: number, intents: Intent[] }
type Result = { n, s: 'ok', seq: number, write?: {t, id: Id, from?: Id, born?: Stamp, f?: Record<string, Stamp>}[],
                detail?: Json }
            | { n, s: 'refused', code: RefusalCode, detail?: Json }
type PushResponse = { serverTime, epoch, lastN: number, results: Result[], retry?: {n: number, retryAfterMs: number} }
```

### §9.4 Pull: `POST /v1/sync/pull`

```ts
type PullRequest = { scopes: {scope: ScopeRef, cursor: string | null}[] }
type Page = { scope, kind: 'rows', rows: Row[], cursor: string, more: boolean, seq: number, digest: string,
              total?: number, header?: {owner: {name: string}} }
          | { scope, kind: 'reset' | 'gone' | 'not-found' }
type PullResponse = { serverTime, epoch, pages: Page[] }
```

`seq` is the scope's seq and `digest` its scope digest, both in the page's snapshot (§6.7, §6.12).
A boot page carries `total` (§6.7 step 3).

Cursors are opaque to clients: base64url of `jcs({e, m, s, k?, a?})`.

### §9.5 Live: WebSocket `/v1/sync/live`

```ts
C→S: { op: 'sub' | 'unsub', scopes: ScopeRef[] } | { op: 'ping' }
S→C: { op: 'change', scope, epoch, seq, digest: string, rows?: Row[] } | { op: 'gone' | 'not-found', scope } | { op: 'pong' }
```

Other `op` values carry ephemeral product messages, such as presence, and the engine ignores them.
Frames are at most `LIVE_FRAME_BYTES`.

### §9.6 Codes: the closed list

| HTTP | `error` | Client action |
|---|---|---|
| 400 | `malformed` | §7.4 |
| 401 | `unauthenticated` | pause (§7.4) |
| 409 | `replica-foreign`, `replica-forked`, `gap` | re-identify |
| 413 | `request-too-large` | §7.4 |
| 426 | `upgrade-required` | stop until upgraded |
| 503 | `unavailable` (`retryAfterMs`) | back off |

| Refusal code | Source |
|---|---|
| `not-found` | §6.1 step 3; A.1 fork |
| `scope-dead` | §6.1 step 3 |
| `forbidden` | §6.1 step 3 |
| `invalid` | §6.1 step 2; §4; §6.4; gym commands |
| `too-large` | §6.1 step 10; §6.11; §7.1 step 8 (local) |
| `clock-skew` | §6.1 step 2 (recovered, §7.7) |
| `id-taken` | §4.3; fork |
| `id-spent` | §4.3 |
| `unknown-record` | §4.3; gym commands |
| `record-dead` | §4.3; gym commands |
| `parent-dead` | §6.1 step 9 |
| `stale` | §6.1 step 7; `gym.applyProposal` |
| `cap` | §6.1 step 12 |
| `base-unknown` | §6.11 (recovered, §7.7) |
| `request-conflict` | §6.3 |
| `request-running` | §6.3 (server origin; retry later) |
| `payload-conflict` | `gym.importSession`, `gym.correctSession` |
| `internal` | §6.6 |
| `session-finished` | gym set rule |
| `session-open` | `gym.start`; delete of an open session (A.2) |
| `target-merged` | §7.7 write map (local) |
| `session-overlap` | `gym.importSession`, `gym.correctSession` |
| `unknown-exercise` | gym check |
| `bad-instant` | gym commands |

### §9.7 Limits

| Limit | Value |
|---|---|
| `MAX_RECORD_BYTES` | 1 048 576, a joined row (admits a 131 072-byte body at worst-case JSON escaping) |
| `PUSH_MAX_INTENTS` / `PUSH_MAX_BYTES` | 64 / 2 097 152 (admits a text intent with its inline base) |
| `PUSH_WORK_MS` | 50 |
| `PULL_PAGE_BYTES` | 1 048 576 (at least one row) |
| `LIVE_FRAME_BYTES` / `LIVE_INLINE_BYTES` | 131 072 / 65 536 |
| `KEEPALIVE_BYTES` | 65 536 |

---

## §10 Clocks

### §10.1 Encoding

D-1 gives the encoding. A parser reads `ms` and `counter` up to the first two colons; the remainder
is the actor.

### §10.2 HLC

```
physNow():  client = deviceWallMs() + serverOffsetMs ; server = wallMs()
tick():     p := physNow(); if p > ms: (ms, counter) := (p, 0)
            else counter += 1; if counter = 2^32: (ms, counter) := (ms + 1, 0)
            return (ms, counter, actor)
observe(s): if (s.ms, s.counter) > (ms, counter): (ms, counter) := (s.ms, s.counter)
```

Clients observe `hlcHigh` at engine start and in every commit, and every stamp of every row the
server sends.

### §10.3 Server stamps

For a server delta, the server:
1. observes the stamp of every register it writes, as stored in the locked rows;
2. ticks once per intent;
3. stamps those registers with the result.

It does not observe client stamps.

### §10.4 Skew, offset and time fields

- **Skew bound.** Admission refuses a stamp beyond `serverNow + MAX_SKEW_MS`, and the server never
  restamps. A `time` value beyond the same bound is clamped to `serverNow` (§6.1 step 2).
- **Offset.** Each response yields `offset = serverTime − (tSend + tRecv)/2` and
  `rtt = tRecv − tSend`. `serverOffsetMs` is the offset of the lowest-RTT sample among the last
  `OFFSET_SAMPLES`, and it is persisted.
- **Time fields.** A `time` field is a device-reported instant, stored as given after the bound.
  The server's own record times are `rc` and `ru`. How a product displays time is the product's
  rule.

---

## §11 Conformance

An implementation **implements the engine** iff it passes, in CI, every item below for its role:
server (C++), or client (JS, Swift, Kotlin).

### §11.1 Golden corpus: `packages/api-contract/sync/`

```
stamp/{order,codec}.json            all      hlc/{tick,observe}.json        all
jcs/values.json                     all      (floats, -0, 1e21, 1e-7, 1.0, unicode, key order)
join/{lww,ranked,fww,life,born,record}.json all (ranked: rank beats stamp; equal ranks)
derive/slug.json                    all      identity/seeded.json           all
fracindex/between.json              client   identity/table.json            server (every §4.3 cell)
admit/*.json                        server   text/diff3.json                server
view/{drawn,stored}.json            client   coalesce/*.json                client (incl. two actors, keyed life)
refusal/fold.json                   client   write/map.json (restamp too)    client
refusal/restamp.json                client (incl. an import intent behind `e`, not restamped)
digest/{row,scope}.json             all      (text, unknown fields; sums that wrap mod 2^256; empty)
lineage/signin.json                 client   (silent add; signed-out and owner-unknown decisions,
                                             each add or discard; dormant(B) untouched)
protocol/*.jsonl                    all      (push, pull, live transcripts)
```

Runners assert exact equality, comparing values by `jcs`.

### §11.2 Property tests

1. The §3.3 laws for the lattice fields, `ranked` included, with equal stamps, equal ranks and
   absent registers.
2. `drawn(coalesced) = drawn(uncoalesced)` for single-actor outboxes.
3. For plain intents admitted by the reference server, the client's `drawn` view after each result
   and pull equals the server rows (INV-6).
4. Admitting any permutation of a set of non-refused plain intents yields equal lattice fields.
5. `between(a, b)` lies strictly between `a` and `b`.
6. A scope digest maintained incrementally over any sequence of row inserts, replacements and
   deletions equals the digest recomputed from the resulting rows (§6.12).

### §11.3 Replay fuzz

A deterministic simulator drives the real engines against the reference server model on every CI
run, and against the real server and Postgres nightly.

**Faults:**
- drop, duplicate, delay and reorder;
- lost replies;
- process death between local transactions;
- clock error of ±10 min;
- holds, undo, leaving the app, and activity or scene recreation;
- multiple tabs;
- sign-in under each lineage outcome (silent add; signed-out and owner-unknown decisions, each add
  or discard), an incomplete sign-in, and sign-out;
- 401;
- poison;
- epoch change;
- a store restored from a snapshot, or cloned.

**It checks after quiescence:**
- INV-2: no resurrection without a revive or a newer keyed put.
- INV-3: every gesture visible, superseded, undone, coalesced or in a notice.
- INV-4, INV-6 and INV-8.
- INV-7: no row of scope S reaches a principal without read access; existence answers are
  identical.
- INV-10.
- INV-15: every digest check matches.
- Every outbox is empty.

---

## Appendix A: Product bindings

Registry entries. "g" marks `idSpace: global`. `chars` and `bytes` are units (D-9).

### A.1 Roadmap

**Surfaces:** web. **Primary types** (§9.2): `tree`.

| Type | Scope | Identity | Life | Fields | Cap |
|---|---|---|---|---|---|
| `tree` | self/roadmap | minted g `^t_[0-9a-f]{16}$`, governs `tree:<id>` | terminal, keep | — | — |
| `track` | self/roadmap | keyed (tree id) | yes, keep | — | — |
| `meta` | tree/T | singleton | — | `title` lww ≤200 chars; `visibility` lww **server** ∈ {private, unlisted, public}; `visibilitySetBy` lww server; `forkedFrom` const server | — |
| `node` | tree/T | derived ≤128 chars, fallback `step` | revivable, keep | lww: `label` ≤200 chars, `icon` ≤64 chars, `color`, `ord` (D-25), `pos` ({x, y} or null), `status`, `description` ≤16 000 chars, `links` (≤32 of {url ≤2048 chars, label ≤200 chars}) | 10 000 |
| `edge` | tree/T | keyed `[from, to]` (`ref<node>` each) | yes, keep | — | 20 000 |
| `kind` | tree/T | derived ≤128 chars, fallback `kind`; genesis `build`, `learn`, `milestone` | revivable, keep | lww: `hue`, `label` ≤24 chars, `description` ≤80 chars, `crossBranchExempt`, `ord` (D-25) | 6 |
| `progress` | self/overlay/T | keyed (`ref<node>` id) | none | `mark` lww `{status: complete\|none, outOfOrder: bool}` | — |

**Gestures:**
- **Atomic:** create tree, which is `tree` + `track`, followed by one `tree/<T>` intent carrying
  `meta.title`, the genesis kinds and the first nodes.
- **Held:** delete node (the node's life and the splice edges it adds), delete tree, delete kind,
  untrack.
- Deleting a node writes no incident edges; an edge with an absent endpoint is masked.
- Undo of a released node or kind delete is a `revive`.
- Every other gesture, including paste, is one intent per record.
- A reorder writes the moved record's `ord`.

**Commands:**
- `roadmap.setVisibility {visibility, stamp}` in `tree/<T>`, by the owner. `stamp` is the
  gesture's stamp.
  - Replay: `stamp` equal to `meta.visibilitySetBy` → ok. Otherwise it writes `visibility` and
    `visibilitySetBy := stamp`.
  - Committed with a guard on the `stored` `meta.visibility` stamp; `stale` if it moved.
  - Predicts `meta.visibility`. A pending prediction's stamp is replaced through the write map
    (§7.7), so a second change guards on the stamp the first one wrote.
- `roadmap.fork {src: ref<tree>, dst: ref<tree>, title?}` in `self/roadmap`.
  - `src` unreadable → `not-found`.
  - `dst` alive, the caller's, with `forkedFrom = src` → ok (replay). Any other state of `dst`
    (§4.3) → `id-taken`.
  - Otherwise: create `tree dst` and `track dst`; write `meta {title: title ?? src title,
    forkedFrom: src}`; copy every node, edge and kind row of `src`, with ids, stamps and born kept
    and `status` cleared. `src` is read under `FOR SHARE` on `sync_scopes(tree:src)`, taken after
    `acct:A/roadmap`.
  - Predicts `tree` and `track`.

**Other bindings:**
- **Projections:**
  - `tree_ops`: one headline per `(tree, gestureId)`, skipping position-only gestures;
  - the tree room: a read cache keyed by `(tree, seq)`.
- **Server-origin writers:** MCP roadmap write tools, each advertising an optional `requestId`
  (§6.3), and tending.
- **Consequences:** a `tree` delete also writes the owner's `track` of that tree dead.

### A.2 Gym

**Scope:** `self/gym`. **Device scope** `device/gym`: live movement order, chosen movement,
pre-minted offer ids, rack state, pictures marked `localOnly` ([gym Coach](mobile/gym_coach.md)
§9.3). **Surfaces:** web, iOS, Android.

Minted ids match `^[A-Za-z0-9_-]{8,64}$`. A seed (D-8) is at most 58 characters, so a seeded id
fits for `n ≤ 99 999`. Seed exercise ids are `foreign` to every account. **Primary types** (§9.2):
`routine`, `session`, `set`, `note`, `weighin`, `exercise`.

| Type | Identity | Life | Fields | Rules |
|---|---|---|---|---|
| `routine` | minted g | terminal, spent | lww: `name` ≤240 bytes, `ord` (D-25), `entries` (≤50 of {`exerciseId`, `restSeconds` 15–900 or null, `sets` ≤20 of {`reps` 1–100 or null, `weightKg` ±500 or null, quantum 0.01}}) | Editor save guarded. Changing `name` or `entries` supersedes its pending proposals. Delete kills its proposals and writes `routineId = null` on its sessions. Projections: `revision`; `position` = dense rank of `(ord, id)` among alive routines. |
| `exercise` | minted g | terminal, spent | `name` lww ≤240 bytes; `pattern`, `equipment` const | Never deleted (a delete is `invalid`). |
| `exerciseName` | keyed (`ref<exercise>`) | yes, spent | `name` lww ≤240 bytes; `aliases` lww server (≤5) | A rename appends the old name to `aliases`. |
| `session` | minted g | terminal, spent | `routineId` lww server `ref<routine>`; `plan` const server; `startedAt` time; `finishedAt` lww server; `closedBy` lww server ∈ {finish, stale}; `displayName` lww server ≤240 bytes | Created only by commands. At most one session with `finishedAt` unset per account. A delete runs `gym.closeStale` inside its admission, then refuses a session whose `finishedAt` is still unset with `session-open`. Delete kills its sets. |
| `set` | minted g | terminal, spent | `sessionId` const `ref<session>` parent; `exerciseId` const `ref<exercise>`; `setNumber` serial, next `[sessionId, exerciseId]`; lww: `weightKg` ±500 quantum 0.01, `reps` 1–500, `kind` ∈ {warmup, working, drop, failure}, `rpe` 1–10 or null quantum 0.1, `note` ≤4000 bytes; `completedAt` time | Set rules below. |
| `note` | minted g | terminal, spent | lww: `title` 1–60 chars, `body` ≤500 bytes, `ord` (D-25) | Cap 10. Editor save guarded. Projection: `position` = dense rank of `(ord, id)` among alive notes. |
| `weighin` | keyed (local date `YYYY-MM-DD`) | yes, spent | lww: `kg` 20–400 quantum 0.01, `recordedAt` | `origins: [replica]` |
| `prefs` | singleton | — | lww, with defaults: `units` ∈ {kg, lb} (kg), `restSeconds` 15–900 or null (null), `restSound` (true), `confirmHaptic` (true), `confirmSound` (false) | Phones edit `units`, `confirmHaptic`, `confirmSound`. |
| `proposal` | minted g | terminal, spent | const: `routineId` `ref<routine>`, `intent`, `proposedName`, `summary`, `changes`, `door`, `connection`; `threadId` lww `ref<thread>`; `state` ranked server (pending 0; applied, dismissed, superseded 1); `supersededBy` lww server | Rules: [gym Coach](mobile/gym_coach.md) §9.2, §11. A replica's create requires `door = ask` and an empty `connection`, and carries a guard (D-19) on every routine register its content is based on, `entries` and `name`, at the stamps it read; a moved stamp → `stale`. `check` re-checks the create by them (`invalid`) and writes `state = pending`. The supersede of the pending proposal of the same `(routine, door, connection)` is written before the new proposal is inserted; at most one is pending per `(routine, door, connection)`. Projections: `baseRevision` and `baseName`, the routine's `revision` and `name` at admission; a replica never supplies them. |
| `thread` | minted g | terminal, spent | `title` const | Fields and rules: gym Coach §9.1. Delete kills its messages and writes `threadId = null` on its proposals. |
| `message` | minted g | terminal, spent | `threadId` const `ref<thread>` parent; `role`, `replica`, `pictures` const; lww: `text`, `truncated`, `receipt`, `calls`; `state` ranked (running 0; interrupted 1; completed, declined, failed, stopped 2); `at` time | Fields and rules: gym Coach §9.1 and §4.5, which `check` enforces (`invalid`). |

**Set rules** (`check`):
- An open session admits every set.
- A session closed by `finish` → `session-finished`.
- A session closed as `stale` admits a set iff `completedAt ≤ finishedAt + 4 h`, and then sets
  `finishedAt := max(finishedAt, completedAt)`. Otherwise → `session-finished`.
- Every exercise reference (a set's `exerciseId`, a routine entry's `exerciseId`, a command's set)
  must be a seed or the owner's; otherwise `unknown-exercise`.

**Commands.** `gym.closeStale` runs first inside `gym.start`, `gym.importSession`,
`gym.correctSession` and a session delete's admission, before every `self/gym` pull, and before
every server read of session state (REST and MCP). It is the only writer of `closedBy = stale`.

- **`gym.start {id: ref<session>, routineId?: ref<routine>, startedAt: time, joinOpenSession}`.**
  Clients send `joinOpenSession: true`.
  1. A start receipt for `id` (the session it created or joined) → ok. When that session is alive,
     the write map carries it with its `born`, and `from: id` if it is a different session.
  2. An open session `o` exists: with `joinOpenSession` → ok, a receipt, and the write map
     `{session, o.id, from: id, born: o.born}`; otherwise → `session-open`.
  3. Otherwise create the session with a receipt, freezing `plan` from the routine. A routine the
     owner cannot read gives `plan = null` and `routineId = null`.

  Predicts the session `{id, born, startedAt, routineId}`, with `plan` composed from the drawn
  routine. A replay whose receipt names a dead session writes nothing; the predicted session stays
  drawn until the cursor covers it.
- **`gym.importSession {id: ref<session>, routineId?, startedAt: instant, finishedAt: instant, sets}`.**
  Creates a finished session (`closedBy = finish`) and its sets, with no join.
  - Own `id`: alive with equal raw arguments (its receipt) → ok; with different arguments →
    `payload-conflict`. An import intent instead creates the sets the server lacks (each set
    admitted alone, with §4.4's drops) and finishes the session if it is open. Dead → ok.
  - `foreign` → `id-taken`.
  - `finishedAt < startedAt`, `finishedAt > serverNow`, or a set outside `[startedAt, finishedAt]`
    → `bad-instant`.
  - The interval crosses another finished session → `session-overlap`.
  - A routine the owner cannot read → `plan = null` and `routineId = null`.

  Sets are numbered in argument order. Predicts the session and its sets.
- **`gym.correctSession {sessionId: ref<session>, requestId, startedAt: instant, finishedAt: instant, routineName, sets}`.**
  Each set is `{id, exerciseId, setNumber, weightKg, reps, rpe?, note?, completedAt: instant}`. It
  replaces a finished workout:
  - The session is alive, the owner's and finished; otherwise `unknown-record`, `record-dead` or
    `invalid`.
  - The `requestId` was applied with equal arguments → ok; with different arguments →
    `payload-conflict`.
  - 1–200 sets; set numbers positive and unique per movement; every instant within
    `[startedAt, finishedAt]` and not in the future → otherwise `bad-instant` or `invalid`.
  - Crossing another finished session → `session-overlap`.
  - An existing set whose `exerciseId` changes → `invalid`. A set keeps its kind; new sets are
    `working`. Set numbers are taken as given. Omitted `rpe` and `note` keep their values. Missing
    prior sets die. A reused or spent set id → `id-taken` or `id-spent`.
  - `closedBy := finish`, and `displayName := routineName`.

  Predicts the session and its sets.
- **`gym.finish {sessionId: ref<session>, finishedAt: time}`.**
  - Absent or `foreign` → `unknown-record`; dead → `record-dead`.
  - `finishedAt < startedAt`, zero or out of range → `bad-instant`.
  - Unfinished → `finishedAt`, and `closedBy = finish`.
  - Closed `stale` → `closedBy = finish`, and `finishedAt := last activity` if `finishedAt > last
    activity + 4 h`, else `max(last activity, finishedAt)`.
  - Closed `finish` → ok.

  Predicts `finishedAt` and `closedBy`.
- **`gym.applyProposal {proposalId: ref<proposal>}`.**
  - Absent → `unknown-record`.
  - `applied` → ok.
  - `dismissed`, `superseded`, or `routine.revision ≠ baseRevision` → `stale`; on a revision
    mismatch, a follow-up server write sets `state = superseded`.
  - Otherwise write the proposal's routine document and `state = applied`.

  Predicts both.
- **`gym.dismissProposal {proposalId}`.** `pending` → `dismissed`; otherwise ok. Predicts `state`.
- **`gym.closeStale`** (server-internal). An open session whose last activity (its last set's
  `completedAt`, else `startedAt`) is at least 4 h before `serverNow` gets
  `finishedAt := last activity` and `closedBy = stale`.

**Client stale rule.** In `drawn`, an unfinished session whose last activity is at least 4 h before
`physNow()` is drawn closed. `liveHint` is true while `drawn` holds an unfinished session that is not
stale. Logging after a stale close issues a new `gym.start`.

**Gestures:**
- **Held:** delete set, delete routine, delete thread, discard session, delete note, delete
  weigh-in.
- **A reorder** writes the moved note's or routine's `ord`.

**Projections:** note and routine `position`, routine `revision` (+1 when `name` or `entries`
change), proposal `baseRevision` and `baseName`, set revisions (what a correction or a delete
replaced).

### A.3 Journal

**Scope:** `self/journal`. **Surfaces:** web, iOS. **Primary types** (§9.2): `page`.

| Type | Identity | Life | Fields |
|---|---|---|---|
| `page` | keyed (local date `YYYY-MM-DD`) | none; `visibleWhen: [body, mood, energy]` | `body` text ≤131 072 bytes; lww: `mood` 0–10 or null, `energy` 0–10 or null, `source` ∈ {typed, spoken} |

**Revisions.** Superseded heads are pruned in the admitting transaction to:
- at most 10 per `(account, day)`;
- at most 500 rows and 8 388 608 bytes per account;
- nothing older than 90 days.

---

## Appendix B: Constants

| Name | Value |
|---|---|
| `HOLD_MS` | 9000 |
| `LEAVE_DEBOUNCE_MS` | 500 |
| `MAX_SKEW_MS` | 300 000 |
| `K_POISON` | 3 |
| `LOCK_TIMEOUT_MS` | 2000 |
| `PULL_FALLBACK_MS` | 300 000 |
| Backoff | base 1000 ms; ceiling 300 000 ms, or 30 000 ms while `liveHint`; full jitter |
| `OFFSET_SAMPLES` | 8 |
| `SCOPE_HORIZON` / `REPLICA_GC` / `REQUEST_RETENTION` | 30 / 365 / 90 days |
| `REQUEST_LEASE_MS` | 60 000 |
| Gym stale window | 4 h |
| `MIG_BORN` | `1:0:mig` |
| `MIG_STAMP` | `1:1:mig` |
| `DEVICE_MIG_STAMP` | `1:0:dev` (< `MIG_STAMP`) |

---

## Appendix C: Migration rules (engine)

**C.1 Identity.** Every record that exists before adoption, including seeded spent rows, has
`born = MIG_BORN` on the server and on every device that imports it. A device import of a record the
server holds is therefore `alive =` or `dead =` in §4.3.

**C.2 Server stamps.**
- Fields keep their existing stamps: roadmap `*_hlc`, `trees.title_hlc`, `node_progress.hlc`, and
  the journal page stamp for `mood`, `energy` and `source`.
- Weigh-ins, on the server and on devices, are stamped `recordedAt:0:mig` (server) and
  `recordedAt:1:dev` (device), for `kg`, `recordedAt` and life, so today's latest-`recordedAt`
  order survives, and an equal instant goes to the device write as today.
- **Order-preserving clamp (INV-14),** per side, for journal and weigh-in stamps, and for roadmap
  stamps on a device. Only roadmap's server-stored stamps are exempt: today's server already
  refused stamps beyond receipt + 5 min, so they satisfy INV-14. The side's instant `M` is the
  server's migration of the product, or on a device `hello.serverTime` at its migration. The side
  sorts its legacy-built stamps with `ms > M` by stamp order, and gives the i-th (from 0) the stamp
  `(M, 2^31 + i, actor)`. Order among clamped stamps is kept, and they sort after every unclamped
  stamp at `M`. Limitation: when one weigh-in, or one journal page's `mood`, `energy` or `source`,
  has future stamps on both the server and a device, the device's clamped stamp sorts after the
  server's, whatever their original order. Likewise for roadmap: a device migrating within
  `MAX_SKEW_MS` of the server, with an exempt future-stamped server value and a newer stranded
  device value on the same field, keeps the server's value.
- Every other migrated field, and every `life_stamp` without a source, gets `MIG_STAMP`.
- A roadmap life derives from its element set: `alive@created` iff created is set and not
  `deleted > created`; otherwise `dead@deleted`.

**C.3 Spent seeding.** Each becomes a spent record with `born = MIG_BORN` and
`life_stamp = MIG_STAMP`:
- `trees.deleted_at` → a dead `tree` record, with `tree:<id>` and its overlays dead;
- `gym_set_revisions.deleted = true` → a spent `set`;
- `gym_ask_deleted_threads` → a spent `thread` (C.8 migrates the alive ones);
- ids with no standing row in `gym_write_receipts`, `gym_routine_creations` and `gym_note_saves`
  → spent records of their kind.

The start receipts in `gym_write_receipts` stay `gym.start` receipts.

**C.4 Order.** Kinds `rank` → `ord`, in `(rank, id)` order. Notes `position` → `ord`, in position
order. Routines `position` → `ord`, in `(position, id)` order.

**C.5 Membership.** A `track` record is created alive for every alive tree's owner, and for every
`(user, tree)` in `node_progress` whose user is not the owner.

**C.6 Counters, seq and digest.** Per scope: count the counters once, assign row seqs in one
ascending pass, set `seq` to the maximum, and compute the scope digest from its alive rows (§6.12).
Generate the epoch.

**C.7 Device import.** Device migration runs only after a successful hello (an offset sample
exists). Device-migration intents are import intents (D-13), one per record unless stated
otherwise. Each takes the lineage of the seat it comes from.

| Legacy local state | Becomes |
|---|---|
| Pending writes: set-queue starts, appends, fixes and deletes; phone weigh-in queues | Intents with fresh ticks (weigh-ins: C.2). Starts become `gym.start`. Creates get `born = MIG_BORN`. |
| Preference documents (owed, and anonymous) | Only fields the surface edits (A.2 `prefs`) that differ from the defaults, with fresh ticks. A document that is not owed is not migrated. A pending change back to a default is therefore not migrated. |
| Shelves (unconfirmed uploads): Android `LocalLog`, iOS gym shelves | A finished session becomes one `gym.importSession` with its sets; an import `gym.importSession` creates its records with `born = MIG_BORN` (C.1). Other records become creates with `born = MIG_BORN` and fields at `DEVICE_MIG_STAMP`, so a server value always wins. |
| Roadmap `windmill:device-trees`, unclaimed trees | `anon` replica import intents, with their lattice stamps. |
| Roadmap claimed trees | Import intents of their IndexedDB `windmill-sync` content, with their lattice stamps. A dead tree's entries end silently (`scope-dead`, §4.4). |
| Journal owed pages (`needsPush`) | `page` writes with `base: {text: ""}` (§6.11 step 1). |
| Anonymous seats | The `anon` replica. |
| Android `ClaimConsent` of a seat | `AwaitingSignIn` → lineage `anon`; `Approved(owner)` → lineage `owner`, in `bound(owner)` or `dormant(owner)`; `Discarding` → the entries end `discarded`. |
| Signed-in seats of account X | The `bound(X)` replica when the session is X; otherwise a `dormant(X)` replica. |
| Unattributed seats (D-3) | An `unattributed` replica. Its entries carry `born = MIG_BORN` and lineage `anon`, and are not import intents. |

Each legacy store is deleted in the transaction that writes its entries.

**C.8 Coach conversations** (server, before C.6, with Ask quiesced: no generation in flight). Each
`gym_ask_threads` row becomes a `thread` with its `id` and `title`. Each `gym_ask_turns` row
becomes a `message`:
- id: the seeded id `<thread_id>-<position>` (D-8). It may exceed the gym seed bound or the id
  pattern, which is harmless: migration bypasses admission, and the only later write that names a
  migrated message is its death as a thread-delete consequence, which skips §6.1 step 2;
- `threadId := thread_id`; `role := lifter` iff `from_lifter`, else `coach`; `text`;
  `at := said_at`;
- a lifter row: `pictures` from `attachments`, as references `{id, mediaType}` to the
  `gym_ask_attachments` rows, which stay as the account's private picture store (gym Coach §9.3);
- a Coach row: `state` from `status` (`interrupted` for `running`, and `failed` for a value outside
  the ranked domain); `receipt` holds the legacy `receipt` and `results` as they are; `replica`
  stays unset.

Every record takes `born = MIG_BORN` and fields at `MIG_STAMP` (C.1, C.2). `gym_ask_generations`
rows are not migrated. Legacy questions, and so titles, are at most 1000 bytes and fit
`MAX_QUESTION_BYTES`. Legacy answers have no byte cap (at most 8 model calls of 8000 tokens), so one
over `MAX_ANSWER_BYTES`, like any value over a gym Coach bound, is migrated unchanged: bounds apply
at admission (§6.1 step 2), and a migrated message has no writer and is never written again.

**C.9 Proposals** (server, before C.6). Each `gym_proposals` row becomes a `proposal` with its
fields. Its `changes` is built from its `gym_proposal_changes` rows in `position` order, and its
`baseRevision` and `baseName` projections come from `base_revision` and `base_name`.
