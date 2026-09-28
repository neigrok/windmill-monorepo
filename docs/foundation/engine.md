# Windmill sync engine

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, steps, definitions
(`D-n`) and invariants (`INV-n`) are numbered so reviews and code can cite them.

## §0 Status and scope

**Status:** Specified; not yet implemented. The engine starts from empty stores.

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
- `actor`: 1–64 bytes of printable ASCII (0x20–0x7E, space included).

It is encoded as the text `ms:counter:actor`, in decimal without leading zeros. The *unset stamp*
`0:0:` has an empty actor and is below every set stamp. Order is defined in §3.1.

**D-2 HLC and actor.** A client replica has one clock state `(ms, counter)`, persisted in
`ReplicaMeta.hlc` and shared by every engine instance (process or browser tab) that uses it. Each
instance has its own actor, minted fresh at every process launch. At a re-identify (§7.11) only the
re-identifying instance takes a new actor; other instances take one at their next launch. The
server has one clock. Actors are:
- a client instance: `r_` plus 12 random `[a-z0-9]`;
- the server: `srv`.

**D-3 Replica.** One device's durable local store for one account binding. Its id is `rp_` plus 32
lowercase hex characters. One device database holds any number of replicas.

| State | Meaning |
|---|---|
| `anon` | No account. It never pushes. |
| `bound(A)` | Signed in as A. It pushes and pulls. |
| `dormant(A)` | A signed out. The confirmed cache is purged; the outbox is kept, not shown and not sent. |

**D-4 Scope.** The unit of sequencing, authorization, bootstrap and live delivery.

| Kind | Server key | Wire reference | Read | Write |
|---|---|---|---|---|
| product | `acct:<A>/<product>`, a product the registry declares | `self/<product>` | A | A |
| tree | `tree:<T>` | `tree/<T>` | owner; anyone while its `opens` field holds an opening value (§2.4) | owner |
| overlay | `acct:<A>/overlay/<T>` | `self/overlay/<T>` | A, while A can read `tree:<T>` | A, while A can read `tree:<T>` |
| device | client only | `device/<product>` | the replica | the replica |

`self` resolves to the authenticated account. A device scope is never sent and never merged. The
products are those the registries declare (D-7); the `probe` product exists only in test and dev
builds.

**D-5 Scope state.** A server scope is `absent`, `alive` or `dead`.
- `tree:<T>` is created by, and dies with, its governing record `T`: a record, in its owner's
  product scope, of the type whose `governs` is `tree` (§2.4).
- Every `acct:*/overlay/<T>` dies in the same transaction as `tree:<T>`.
- Product scopes are alive for the account's lifetime.
- A dead scope never becomes alive (INV-13).

**D-6 Record.** `(scope, type, id)` with:
- an optional life `[alive|dead, stamp]`;
- an optional `born` stamp (the stamp of its create);
- named fields;
- the server-assigned `seq` (the scope seq of its last change);
- `rc` and `ru`: server receipt ms of the create and of the last change.

**D-7 Registry.** A registry file (`*.registry.json`) declares products, types, fields and commands,
in the format of `packages/api-contract/sync/registry.schema.json` (§2.4). It is code-generated into
all four implementations.

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
seed and ordinals produces the same ids. A type whose ids may be seeded declares `seeded`: the
seed's maximum length and the largest ordinal, so that `<seed>-<n>` fits its id pattern; seeds are
minted within that bound. A type's `mint` declares how a CSPRNG id is minted: prefix, alphabet and
length (§2.4). A client draws a minted id again while it is taken (§4.4).

**D-9 Field kinds.**

| Kind | Meaning |
|---|---|
| `lww` | last writer wins (§3.2) |
| `ranked` | the value of higher rank wins, then the later stamp (§3.2); the registry ranks the values |
| `fww` | first writer wins (§3.2) |
| `const` | joins as `fww`; a client writes it only in the create |
| `time` | a device-reported instant, an integer epoch ms; joins as `const`; clamped at admission (§10.4) |
| `serial` | an integer assigned by the server at admission; clients never write or predict it |
| `text` | a string merged by the server (§6.11); clients never join it |

Every field also has:
- a **writer**: `client`, or `server` (only the server writes it);
- bounds, with a stated **unit**: `chars` (Unicode code points) or `bytes` (UTF-8), plus a
  `domain` (which carries any `quantum`) where the field has one. A bound on a value that is not a
  string measures the value's `jcs` encoding.

`lww`, `ranked`, `fww`, `const` and `time` fields, life and born are **lattice fields**. `text` and
`serial` are **server-sequenced**.

**D-10 Reference.** A field or command argument typed `ref<type>` holds an id of that type, or null
where its domain is nullable. It drives dependent folding and the write map (§7.7).

**D-11 Spent id.** An id whose record is dead, for a type whose death is terminal. A spent id is
never alive again (INV-2).

**D-12 Delta.** A partial record state: `(type, id)` plus any of life, born and fields with stamps.
A text field carries `{text, base}` (§6.11). A minted or derived delta always carries `born`.

**D-13 Intent.** The unit of admission: deltas for records of one scope, an optional guard list
(D-19), an optional command (D-20) and an optional `gestureId`. It is admitted atomically.

**D-14 Gesture.** One user act. `commit` (§7.1) turns it into one intent (atomic) or one intent per
record. The intents of one gesture share one stamp and one `gestureId`.

**D-15 Intent states and outcomes.** States: `held`, `ready`, `sent`, `acked`. Terminal outcomes:
- `undone`: Undo, or a retire (§7.1 step 4), while held, and every dependent entry that the silent
  fold of either empties (§7.3);
- `resolved`: `ok`, and the scope's cursor covers it;
- `refused`: a notice holds it;
- `discarded`: the person discarded it (sign-out Discard, a lineage decision, or an explicit
  discard of a dormant replica, §7.10).

Transitions are in §8.1.

**D-16 Result.** The server's one final answer per intent (§9.3):
- `ok`: with the scope seq after admission, a command's write map, and a detail;
- `refused`: with a code.

**D-17 Notice.** The durable, per-product client record of a refused intent, holding the code, the
intent's content and the content of the dependents folded into it (§7.7). A product MAY dismiss a
notice, which hides it; content that later folds into a dismissed notice shows it again. A notice
that an outbox entry's `orphanOf` names is never deleted.

**D-18 Seq, epoch, cursor.**
- `seq`: a per-scope counter, incremented once per committed intent that changes the scope.
- `epoch`: one random string for the whole server database, regenerated when the database is
  restored from a backup.
- A cursor is `(epoch, mode ∈ {boot, live}, seq, key?, asOf?)`, encoded as §9.4 states; clients
  decode it.
- The *scope digest*: a per-scope sum of the hashes of the scope's alive rows (§6.12).

**D-19 Guard.** `(type, id, field, stamp | null)`. It holds iff the stored register's stamp equals
`stamp`, or the register is unset and `stamp` is null.

**D-20 Command and write map.** A command is a named server function (§6.4, Appendix A) that runs
inside admission and produces server-stamped deltas. Its `ok` result always carries a **write map**,
possibly empty: one entry `{t, id, from?, born?, f?}` per record it wrote or resolved to, giving the
id it mapped `from`, the record's `born`, and the stamp of every field it wrote (§7.7).

**D-21 Hold.** A `releaseAt` on the intents of a destructive gesture. They are `held` (not sent)
until released (§7.3).

**D-22 Views.** `confirmed` is the cache of server rows. `drawn` and `stored` are the predictive
views (§7.6).

**D-23 Origin.**
- `replica(R, n)`: a client push.
- `server(A, requestId?)`: MCP, REST API, tending, or a server-internal command.

**D-24 Cap.** A per-type ceiling on alive records in a scope, enforced by the growth rule (§6.5).

**D-25 Fractional key.** The jitterless base-62 order key of the reference model
(`packages/api-contract/sync/reference/core/fracindex.js`).
- Keys compare bytewise, and a list sorts by `(key, id)`.
- `between(a, b)` returns a key strictly between `a` and `b`.
- When two neighbours hold equal keys, a key inserted after the first of them is
  `between(a, the next greater key)`.
- **List.** The list of an order field, in a view, is every visible record (§7.6) of its type in the
  scope that holds the field. A list per parent needs a split the registry declares, and the registry
  format declares none.
- **Drop position.** A member placed into a list, by a move or an anchored create (§7.1 step 4),
  takes a key between the *anchor*, the row immediately above the drop point, and the first
  `stored` row whose key is greater than the anchor's, the placed member excluded. At the top it
  goes before the first `stored` row; with no such `stored` row, after the anchor. The anchor is
  looked up in `drawn`, then in `stored`: it may be a row only `drawn` holds, or a member inside a
  delete window (§7.3), which only `stored` holds. A member inside a delete window so also keeps
  its stored place. A member moved below itself is its own anchor: it takes a key between its
  drawn key and the first greater `stored` key, and keeps its place.

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
was committed signed out. It is set at commit, and changes only when the lineage rule adds the
entry to an account (§7.10). So every entry of a `bound(A)` or `dormant(A)` replica has lineage A,
and every entry of the `anon` replica has lineage `anon`.

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
sync_spent   (scope text, type text, id text, born text null, life_stamp text not null, seq bigint not null,
              primary key (scope, type, id))            -- born null for a keyed type; indexes (scope, seq), (type, id)
sync_requests(account uuid, request_id text, digest bytea not null, state text,   -- running | done
              result jsonb null, started_at timestamptz, primary key (account, request_id))
```

### §2.2 The envelope on typed product tables

Each table storing a synced type holds its typed columns as the truth, and:

| Column | On |
|---|---|
| `scope_key`, `seq`, index `(scope_key, seq)` | every synced table |
| `rc`, `ru` | every synced table |
| `<field>_stamp` | every lattice field |
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
  virtual std::map<Id, Row> lock(Txn&, const ScopeKey&, std::span<const Id>) = 0;    // this scope's typed rows, FOR UPDATE
  virtual std::set<Id> elsewhere(Txn&, const ScopeKey&, std::span<const Id>) = 0;    // global ids another scope's rows hold
  virtual Verdict check(Txn&, const AdmitCtx&, std::vector<Change>&) = 0;             // product rules on joined records
  virtual void apply(Txn&, const ScopeKey&, Seq, const std::vector<Change>&) = 0;     // typed rows, revisions, projections
  virtual std::vector<Row> feed(Txn&, const ScopeKey&, const FeedQuery&) = 0;         // keyset (seq, type, id)
  virtual std::uint64_t count(Txn&, const ScopeKey&, const FeedQuery&) = 0;           // a boot's total (§6.7)
  virtual std::optional<std::int64_t> maxSerial(Txn&, const ScopeKey&, Field, const std::map<Field, Json>& match) = 0;
  virtual std::optional<std::string> revisionText(Txn&, const ScopeKey&, const Id&, Field, Seq rev) = 0;
  virtual void purge(Txn&, const ScopeKey&) = 0;                                      // G5 and account deletion
  virtual void sweep(Txn&, Ms now) = 0;                                               // G6
};
```

The engine composes each id's state (§4.2) from `lock`, `elsewhere` and its own tables; a product
adapter never reads a `sync_*` table. `maxSerial` serves §6.1 step 11.

### §2.4 The registry

The registry's format is `packages/api-contract/sync/registry.schema.json`, and that schema is
authoritative. A registry declares its `version` and `minVersion` (§9.2), its `products` (each with
its `surfaces`, its device rows and its refusal `codes`), its `types` and its `commands`. Every
product-specific behaviour the engine applies is registry data or a product binding (Appendix A); the
engine body names no product. Each product ships a registry of its own
(`packages/api-contract/sync/<product>.registry.json`), and a deployment composes them into one:
they declare one `version` and one `minVersion`, and no product, type or command name twice. A
registry that drops a product raises `minVersion` above every version that declares it, so a client
that still carries the product is answered `426` (§9.1).

- **Types:** `scope` (`product:<name>`, `tree` or `overlay`), `identity`, `idSpace`, `idPattern`,
  `key` (a keyed type's natural key: an id of another type, or a tuple of such ids, whose types, and
  the types their own keys name in turn, never lead back to the keyed type), `singletonId`,
  `derive.fallback` (D-26), `seeded` and `mint` (D-8), `life`, `wholePut`, `revivable`, `deadRows`,
  `governs`, `origins`, `fields`, `cap`, `visibleWhen` and `primary`.
- **Fields:** `kind` (D-9), `writer`, `ref`, `parent`, `unit`, `min`, `max`, `domain`, `default`,
  `serialNext`, `rank` and `opens`.
- **Domains** are structured: `string` (`enum`, `pattern`, `unit`, `min`, `max`), `number`
  (`integer`, `min`, `max`, `quantum`), `boolean`, `fracKey` (D-25), `stamp`, `id`, `json`, `array`
  (`items`, `maxItems`) and `object` (`properties`, `required`), each `nullable` or not. Nested bounds
  are domain bounds, checked at §6.1 step 2. A string domain's `min` or `max` states its `unit`, as a
  field's bound does (D-9).
- **Patterns** (`idPattern`, a string domain's `pattern`, a device row's `keyPattern`) are printable
  ASCII, in a portable subset of ECMAScript regular expressions. A value matches a pattern iff the
  pattern matches the whole value. A pattern is `^`, a body, then `$`. The body holds only literal
  characters other than `^$\.*+?()[]{}|`; `\` before one of `^$\.*+?()[]{}|/`; bracket classes of
  literal characters, those escapes, `\-` and ascending ranges, not beginning with `:`, with no `[`,
  `&`, `~` or `--` inside, and a bare `-` only first or last; groups `(…)` and `(?:…)`, the only place
  a `|` may stand; and the quantifiers `?`, `*`, `+`, `{n}`, `{n,}` and `{n,m}`, each after an atom,
  with `n` and `m` at most 65 535. Anything else (`.`, class escapes such as `\d`, `\s`, `\w` and `\b`,
  negated classes, backreferences, lookaround, lazy quantifiers, flags) makes the registry invalid.
  Each atom so matches one ASCII character, whether bytes or code points are counted. These semantics
  define a match, not any named regex engine: an implementation matches by them, with an engine that
  honours them for the subset or with a matcher of its own, and never by a search, which in some
  dialects lets `$` match before a final line terminator.
- **Commands:** `name`, `scope`, `origins`, `serverInternal`, `beforePull`, `args` (each of type
  `json`, `time`, `instant` or `ref<t>`, `optional` or not, with a `domain`) and `predicts`.

The engine applies:
- `parent: true` marks the one `ref` field whose target must be alive (§6.1 step 10).
- A `fracKey` field, an order field (D-25), belongs to a minted or derived type.
- `rank` gives each value of a `ranked` field an integer rank; its keys are the field's domain.
- A type's `origins` always include `replica`: a replica MAY create a record of any type, by a
  delta or through a command as its binding allows, and the product's `check` re-checks it (§6.1
  step 10).
- `primary` marks the types whose records make an account hold records in the product (§9.2).
- `visibleWhen` lists fields: a record of a type without life is visible iff one of them holds a
  value other than null or `""`. Without it, the record is visible iff it holds any lattice register
  or text, whatever the value; serial values do not count.
- `governs: tree`: each record of the type governs `tree:<id>` (D-5). A governing type is minted,
  in the `global` id space, and not revivable.
- `opens`: on a `server`-written field of a `tree`-scoped singleton, the values that open the tree
  to every reader (D-4).
- `beforePull`: a server-internal command that runs before every pull of its scope, unless the scope
  is absent, in its own admission with the scope owner's server origin (§6.7).
- A `time` argument is device-produced, like a `time` field. An `instant` argument is chosen by the
  user.
- `quantum`, on a number domain at any depth (a field's, an item's, a property's, an argument's): a
  positive integer, or `1/k` for an integer `k` (so `1 / quantum`, in IEEE-754 doubles, is an
  integer: 0.5 and 0.01, never 0.3 or 2.5). The server admits only numbers on it (§6.1 step 2), and
  a client rounds every number of a change's field values and of a command's arguments to it (§7.1
  step 4).
- `wholePut`, on a keyed type with life, no text field and only `lww` client-written fields: each
  record is one fact, whose newest save wins whole. Every put that leaves the record present writes
  every client-written lattice field and asserts presence with a fresh life, all at one stamp (§7.1
  step 4). So the newest save wins every field, and a save newer than a delete, held or not, makes the
  record alive again (INV-2). Admission refuses any other delta of the type (§6.1 step 2). Such a
  record is written only by deltas: no command writes one and no product check appends one, and the
  registry refuses a command whose `predicts` names the type.
- `default`, on a lattice field: the value a reader takes while the register is unset. It is on the
  field's domain, and the engine never stores or sends it.
- `codes`: the refusal codes a product's `check` and commands answer beyond the engine's (§9.6). No
  code is an engine code, and no two products declare one.

### §2.5 Client: the local store

The store MUST provide atomic, durable transactions spanning every table below.

```ts
type DeviceMeta  = { forkGuard?: string, pendingSignIn?: { account: string } }  // one per local database
type ReplicaMeta = { replica: string, state: 'anon'|'bound'|'dormant', account?: string,
                     nextN: number, hlc: {ms: number, counter: number}, hlcHigh: Stamp, admittedHigh: Stamp,
                     serverOffsetMs: number, offsetSamples: {offset: number, rtt: number}[],
                     clockReading?: {wall: number, mono: number, boot: string},
                     serverEpoch: string | null, ackThrough: number, authPaused: boolean }
type ConfirmedRow = Row                                  // keyed (replica, scope, type, id); replaced, never joined
type SpentId = { replica, scope, type, id, born }        // derived types only
type CursorRec = { replica, scope, cursor: string | null, digest: string, booted: boolean,
                   mismatchReset?: true, digestStop?: string }
type KnownScope = { replica, scope, kind: 'gone' | 'not-found' }
type OutboxEntry = { localId, replica, gestureId, lineage: string /* account id | 'anon' */, scope,
                     state: 'held'|'ready'|'sent'|'acked', stamp: Stamp,
                     commitOrder: number, releaseAt: number, n?, digest?, intent: Intent,
                     predict?: Delta[], baseTexts?: Record<string, string>,   // (t, id, field) → text edited from
                     resultSeq?: number, resultEpoch?: string, orphanOf?: string }
type Notice = { id, replica, scope, code: RefusalCode, detail?,
                content: { d?: Delta[], cmd?: Cmd, dependents?: { d?: Delta[], cmd?: Cmd }[] }, at,
                dismissed?: true }
type DeviceRow = { replica, product, key, value: Json }  // device/<product>
```

- `hlcHigh`: the greatest stamp this replica minted or observed.
- `admittedHigh`: the greatest stamp in any row the server sent (pull, live) or in an acked entry.
- `CursorRec.digest`: the scope digest (§6.12) of the replica's confirmed rows of the scope. A boot
  into staging keeps its own digest until the swap (§7.5).
- `CursorRec.booted`: the scope's first pull is complete, a boot having finished with the cursor
  live (§7.5). It is deleted with the scope's cursor.
- `CursorRec.mismatchReset`: a digest mismatch reset the scope, and no check has matched since
  (§7.5).
- `CursorRec.digestStop`: the app version at which digest checks of the scope stopped (§7.5).
- `KnownScope`: a tree or overlay scope known gone or not-found (§7.5), which §7.1 step 2 refuses.
- `Notice.dismissed`: the product dismissed the notice, and no content has folded into it since
  (D-17).
- `OutboxEntry.stamp`: the gesture's stamp (§7.1 step 3), which only `clock-skew` recovery moves
  (§7.7). `localId` is `<gestureId>/<k>`, the gesture's k-th intent from 0; gesture ids, and so local
  ids, are unique on the device.
- `DeviceMeta.forkGuard`: a random token for the whole local database, kept both in it and in
  storage excluded from device backups (iOS `isExcludedFromBackup`, Android `noBackupFilesDir`). Web
  runs no fork guard.
- `DeviceMeta.pendingSignIn`: an incomplete sign-in, resumed at the next engine start (§7.10).
- `liveHint` (§7.4) is not stored: the product's view rule computes it when the sender backs off
  (Appendix A).

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

### §3.3 Laws

Each register join takes the maximum of a total order (for `ranked`, the order of
`(rank, stamp, jcs)`). The maximum of a total order is idempotent, commutative and associative,
with the absent register as identity, and `joinRecord` is their pointwise product. The lattice
fields of any set of applied deltas are therefore independent of admission order.

Text and serial fields are outside these laws. They are sequenced by the server's single admission
order (§6.1).

### §3.4 What clients join

A client never joins confirmed state. A server row replaces the confirmed row when its `seq` is
greater than or equal to the stored row's `seq`. Clients join only in the overlay views (§7.6).

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

The engine composes the id state from `lock`, `elsewhere` and its own tables (§2.3):
- `none`: no row and no `sync_spent` row for the id in the scope. For `idSpace: global`, none in any
  scope. For a governing type, no `sync_scopes` row for the governed scope.
- `foreign`: `idSpace: global` and the id exists or is spent in another scope; or, for a governing
  type, the governed scope exists and is not governed by this `(scope, type, id)`.
- `alive(b)`, `dead(b)`: alive or dead in this scope, with born `b` (a keyed type's spent row has
  no born).

Before `lock`, admission locks each fresh id of a global id space the intent creates, by
`(type, id)` in ascending order (§6.1 step 3.6), so two scopes creating one fresh id are serialized.
An id that only a command's arguments or `check` reveal is locked on demand, just before its lookup.

### §4.3 Decision table (minted and derived)

`=` means `b = δ.born` and `≠` means `b ≠ δ.born`. "ok" means `ok` with no change.

| Op | `none` | `foreign` | `alive =` | `alive ≠` | `dead =` | `dead ≠` |
|---|---|---|---|---|---|---|
| `create` | apply | `id-taken` | apply (join) | `id-taken` | ok | `id-spent` |
| `update` | `unknown-record` | `unknown-record` | apply | `unknown-record` | `record-dead` | `unknown-record` |
| `delete` | ok | ok | apply | ok | apply (join) | ok |
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
- **Spent ids.** No client mints an id that is alive, spent or pending in its views (§7.1). A
  minted id taken there, a row or a `SpentId` the server reported included, is drawn again. The
  server's own derived minting uses `taken` = the scope's alive and spent ids.

---

## §5 Invariants

**INV-1 Causal dominance.** A stamp minted by a replica, or by the server, after it observed a
server-sent stamp `s` is greater than `s`.

*Proof.* `observe(s)` raises the clock to at least `(s.ms, s.counter)`, and `tick` returns a
strictly greater pair (§10.2). Clients observe every row the server sends them, `hlcHigh` in every
commit, and a write map's stamps before they restamp the later entries that write the same registers
(§7.7). `clock-skew` recovery lowers the clock only to the pair maximum of `(physNow(), 0)` and
`admittedHigh`, which is at least every server-sent stamp. The server observes, under the row lock,
every register it overwrites (§10.3).

**INV-2 No accidental resurrection.** A record that an admitted delete made dead is alive again only
through:
- an admitted `revive` of a revivable type; or
- for a keyed type, an admitted `put` whose life stamp exceeds the delete's.

*Proof.*
- **Minted and derived.** §4.3 answers a create onto `dead` with a no-op or `id-spent`. An update
  carries no life. Only `revive` sets alive.
- **Keyed.** A replayed put carries its original life stamp. The deleting replica had observed the
  record it deleted, so by INV-1 the delete out-stamps that put. A put that does not change presence
  carries the drawn life register unchanged (§7.1 step 4), and a restamp moves such a carried
  register only with its source (§7.7). A put of a `wholePut` type asserts presence at its own
  stamp: it makes the record alive again only when its stamp follows the delete's, the newer save the
  statement admits; a replay keeps its stamp, and a delete that out-stamps it stands. Stamp order, not
  wall-clock order, decides: a clock-skew recovery restamps a whole put to the recovery moment
  (§7.7), so a skewed save made before a delete in real time recovers after it and keeps the record.
- **Dead state is retained.** Dead rows and `sync_spent` rows are kept for the scope's lifetime
  (§6.10). The `born` and `life_stamp` columns (§2.2) make every comparison exact.
- **Clients** push only intents (§7.4), replace rather than join confirmed rows (§3.4), and never
  mint a spent id (§4.4, §6.7).
- **Scope death** refuses every write (INV-13).

**INV-3 No silent loss.** While the replica's local store survives and the server's committed state
survives, every committed intent ends in exactly one outcome of D-15. An intent that ends `refused`
has a notice holding its content, written in the same local transaction; an orphan's content is in
its origin's notice (§7.7).

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
- A refusal folds its dependents into the same notice: the removed content of held and ready
  entries, and the whole content of orphans, the sent entries with a dependent part. An orphan's
  refusal folds its own dependents into it too (§7.7).
- `clock-skew` recovery moves borns and guards in every later unacked entry, sent ones included, so
  a refused batch recovers as a whole (§7.7).

**INV-4 At most once.** An intent from a replica, or a server-origin write that carries a
`requestId`, takes effect at most once.

*Proof.*
- `last_n`, the result and the effects commit in one transaction, which locks the replica row and
  re-checks `last_n` (§6.1 step 3); step R and a fault path re-check it too, under the scope mutex
  (§6.1, §6.6). A resend with `n ≤ last_n` returns the stored result. A missing or different digest
  for such an `n` answers `replica-forked` (§6.2).
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
- (c) A replica pushes only under its bound account: a push names its account and is refused
  `account-mismatch` unless served as it, before anything is bound or admitted, and a replica id
  bound elsewhere is refused `replica-foreign` (§6.2).
- (d) An entry of another account's lineage is never adopted, and sign-out purges the confirmed
  cache (§7.10).
- (e) Existence: for a principal without read access, an absent, private or dead scope answers
  `not-found` identically on push, pull, live and every command that reads another scope, and a
  `foreign` id answers `id-taken` without its state. (Creating a governing record under a global id
  reveals that the id is in use.)
- (f) A tree opens to other readers only through its `opens` field, which is `server`-written
  (§2.4, §4.4).

*Proof.* Each clause is enforced at its cited step. No other path emits rows or accepts writes.

**INV-8 Caps.** No admitted intent raises a type's alive count above its cap. A write that does not
raise the count is never refused by the cap. A client never composes an add that the server would
refuse only because a delete is held.

*Proof.* Counters of capped types live on the scope row and are updated under the scope lock, with
the growth rule (§6.5). The client applies the same rule to `stored`, which counts held deletes
(§7.1 step 8, §7.6).

**INV-9 Bounded poison.** An intent whose admission faults deterministically is attempted at most
`K_POISON` times, and the replica's later intents then proceed.

*Proof.* Faults are counted per `(replica, n, digest)` in a separate transaction, and at `K_POISON`
the result `internal` is stored and `last_n` advances (§6.6).

**INV-10 Hold durability.** A held gesture is sent iff neither Undo nor a retire (§7.1 step 4)
removes it before release, the person does not discard it (§7.10), and it is not folded with a
record it depends on (§7.3, §7.7).
Process death and in-app navigation, including an activity or scene recreation, never abandon it.
The early releases, which end Undo, are leaving the app, sign-in and sign-out (§7.3, §7.10). After
process death, the next engine start releases it.

*Proof.*
- Held entries are durable rows. They leave `held` only by `release`, `undo`, a retire, a discard
  or a fold (§7.1 step 4, §7.3, §7.7, §7.10).
- `undo` succeeds, and a retire acts, only while every entry of the gesture is held. A retire acts
  in the retiring commit's own transaction, on command-free gestures that only remove records the
  commit names (§7.1 step 4).
- Release runs in every replica state: at `releaseAt` by an in-process timer, on leaving the app, at
  engine start, and at sign-in and sign-out.

**INV-11 Product invariants.** Every invariant stated in Appendix A holds in every committed state.

*Proof.* Product checks and commands run inside the scope-locked admitting transaction (§6.1), and
database constraints back them up.

**INV-12 Merge keeps text.** The result of a text merge contains:
- every non-whitespace token that `head` or `mine` inserted or changed relative to the base;
- every non-whitespace base token that neither side deleted.

Containment is per token occurrence of the edit scripts (§6.11), not a count of equal tokens
(§11.2 property 7). A result over the field's cap is refused `too-large`, and the notice holds
`mine`.

*Proof.* Every diff3 region (§6.11) is stable, a one-sided change, a region where a side changes
only whitespace, which emits the other side (head's when both do), or a conflict that emits both
changed sides. Over `MERGE_WORK_CELLS` the whole text is one conflict region, which emits both sides
whole.

**INV-13 Scope death is final.**

*Proof.* A governing type is minted and not revivable (§2.4, §4.3). Overlays die in the same
transaction as their tree (D-5), and an overlay's admission holds its tree's row shared, so no
overlay is created or written past its tree's death (§6.1 step 3). Every write to a dead scope is
refused, and every read answers `gone` or `not-found`.

**INV-14 Bounded stamps.** The server never stores a stamp whose `ms` exceeds the server time at
which it is stored plus `MAX_SKEW_MS`, on any path. So a replica that observes stored stamps with a
correct offset never mints a stamp that §6.1 step 2 refuses, and `clock-skew` recovery terminates.

*Proof.*
- Client stamps are refused beyond the bound (§6.1 step 2), against a `serverNow` read before they
  are stored.
- Server stamps are minted once per pass of §6.1 step 9, each one tick after observing stored
  stamps, the stamps of the intent's client deltas and an earlier pass's stamps, all bounded, by
  induction from empty stores (§10.3).
- Recovery terminates. The `serverNow` of §6.1 step 2 never steps back within a server process
  (§10.2), so a stamp that passed the skew check once passes it again there. A step back of δ
  across a restart, or between server processes, costs a bounded number of extra refusals, one per
  backoff (§7.4) or leave flush (§7.3), until the wall clock regains δ.
  - Recovery (§7.7 step 1) ticks every register a held or ready entry wrote from the pair maximum
    of `(physNow(), 0)` and `admittedHigh`. With a correct offset `physNow()` passes, and
    `admittedHigh` is a stamp that passed.
  - Every other stamp an unacked entry carries is a born or a carried life register. Its source is
    an earlier unacked entry, whose restamp moves it (§7.7 restamp rule); a command's prediction,
    which the write map moves before any entry behind the command is numbered (§7.4, §7.7); or an
    admitted stamp.
  - No source leaves the outbox unadmitted with a dependent behind it. An undo and a retire fold
    their dependents silently (§7.3), none of which is numbered while its source is held (§7.4).
    A refusal folds the queued dependents and orphans the sent ones. An orphan's whole content is a
    source whose dependents are held back until its result: its `ok` admits their source, and its
    refusal, which recovers nothing, folds them (§7.4, §7.7). A discard ends every entry of its
    product (§7.10).
  - So a recovered entry's resend passes the check.

**INV-15 Verified replica.** A replica whose cursor for a scope is live at seq N, without a key,
holds exactly the server's alive rows (§6.12) of the scope at N, or detects that it does not at its
next digest check (§7.5).

*Proof.*
- The server's scope digest at every committed seq is the sum over the scope's alive rows at that
  seq. It starts at 0, and the transaction that changes a row changes it (§6.12).
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

These steps are an ordered, fail-fast pipeline. A refusal at any step goes to step R. A
server-origin intent carries null stamps, which step 9 mints (§10.3).

1. **Scope.** Map the reference to its key (`self` is the origin's account).
2. **Shape.**
   - Registered types for the scope kind; registered fields and command; a command's arguments, each
     present unless `optional`.
   - At least one delta or a command, and at most one delta per `(type, id)`.
   - `idPattern`, bounds, units, domains and quanta (a number off its quantum, §7.1 step 4), and
     every integer a safe integer (§9.1), a text base's `rev` included. A text field's `max`
     applies to its merge result (§6.11 step 3).
   - §4.1, and §4.4's serial and server-field rules.
   - A delta of a `wholePut` type carries a life. An alive one carries every client-written lattice
     field of its type, every register at the life's stamp; a dead one carries no field register, so
     a losing delete plants nothing (§2.4).
   - The `<T>` of a `tree/<T>` or `self/overlay/<T>` reference matches the governing type's
     `idPattern`.
   - No string of the intent, a key or a value at any depth, holds U+0000.

   Failure → `invalid`. Then a stamp with `ms > serverNow + MAX_SKEW_MS` in any delta's life, born
   or fields (not in a guard) → `clock-skew`. A `time` field or `time` argument beyond
   `serverNow + MAX_SKEW_MS` is clamped to `serverNow`. An `instant` argument beyond it → `invalid`.
   In a push, this `serverNow` is read once per request, and every intent of the request is checked
   and clamped against it.
3. **Lock and access.** Locks are taken in this order: the replica row or the request lock (3.3);
   for an overlay intent, its tree's row held shared (3.4); for every intent, its scope row and the
   trees its command's arguments name, in one ascending-key pass (3.5); fresh global ids (3.6); the
   rows (step 5); then the scopes a governing record creates or kills, tree first (step 15).
   The order has no cycle except through step 15's locks or an id locked on demand (3.6): every
   scope and tree row of 3.5 is taken in that one pass, and 3.4's shared mode conflicts only with a
   death. A deadlock through those is retried as transient (§6.6). No overlay outlives its tree.
   1. Take the in-process mutex of the scope key with timeout `LOCK_TIMEOUT_MS`.
   2. `BEGIN`; `SET LOCAL lock_timeout`.
   3. A replica origin locks its `sync_replicas` row, inserting it with `last_n = 0` when absent,
      and re-checks, in this order, that the row is bound to the origin's account, else the push
      stops with `409 replica-foreign`, and that `n = last_n + 1`, else the intent is answered as
      §6.2 step 4 answers it.
      A server origin with a `requestId` takes `pg_advisory_xact_lock(A, requestId)` here, and
      step 4 runs the lookup under it.
   4. An overlay intent locks `tree:<T>` shared, in a mode only its death conflicts with (Postgres
      `FOR KEY SHARE`; scope writes take `FOR NO KEY UPDATE`, a death `FOR UPDATE`).
   5. An absent product scope, or an absent overlay scope whose `tree:<T>` is alive and readable
      by the origin, is inserted `alive`, with seq 0 and digest 0 (`INSERT … ON CONFLICT DO
      NOTHING`). Then every intent, of any scope kind, locks in one pass in ascending key order its
      scope row and, for each command argument typed `ref<t>` where `t` governs `tree`,
      `tree:<value>`, each row once in the stronger mode it needs: the scope row `FOR NO KEY
      UPDATE`, an argument tree `FOR SHARE`. A tree-scope intent's own row so takes its key's place
      among its argument trees. An id that no scope has yet locks nothing.
   6. Each fresh id of a global id space that the intent creates is locked by `(type, id)` (§4.2).
      An id that only a command's arguments or `check` reveal is locked on demand, just before its
      lookup.
   7. Refuse:
      - `not-found`: absent; or the origin cannot read the scope; or dead and the origin is not its
        owner. An overlay answers as its tree does: `scope-dead` only to the tree's owner,
        `not-found` to everyone else.
      - `scope-dead`: dead and the origin is its owner.
      - `forbidden`: readable but not writable, or a type's `origins` excludes the origin (for
        deltas outside a command), or a server-internal command from a replica.
4. **Server origin.** With a `requestId`, run §6.3's lookup, then build the deltas.
5. **Rows.** Call `lock` for every `(type, id)` that the deltas, guards and command touch.
6. **Identity.** Apply §4.3 to each delta, and §4.4's const and time rule against the locked
   row.
7. **Guards.** A command's replay is determined first, by its replay rule (Appendix A) from the
   locked rows and its stored arguments; a replay skips the guards. Otherwise each guard (D-19) must
   hold, else `stale` with detail `{t, id, field, current}`. A guard also holds when the stored
   register already carries the stamp this intent writes to it (a replay, for example after
   re-identify).
8. **Command.** Run the handler (§6.4). Its deltas pass steps 5, 6 and 9.
9. **Join.**
   - The server stamps of the deltas this pass joins are minted (§10.3). A later pass, for deltas
     step 10 appends, observes their registers and ticks again; the write map carries the first
     pass's stamp.
   - `after = joinRecord(before, δ)` for each delta, in order.
   - Text fields are merged (§6.11).
   - Each row the intent changes, in its scope or in one it creates, is measured as step 13 would
     store it, before step 11 gives a new record its serial: an encoding over `MAX_RECORD_BYTES` →
     `too-large`. Text bases do not count, and a row the intent leaves unchanged is not measured.
10. **Product check.** `check` per type touched, on the joined records.
    - A create from a replica is re-checked like any write: `check` re-computes and validates every
      value the product's rules derive (Appendix A).
    - Appendix A rules may refuse with their codes, or append server deltas, which pass steps 5, 6
      and 9. `check` runs once: the deltas it appends are not checked again.
    - Then every create or update of the intent, a command's or an appended one's included, whose
      `parent` reference is not alive among the joined records → `parent-dead`. A parent created in
      the same intent counts as alive. The reference is read from the join, before G1 (§6.10)
      drops a dead record's fields.
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
14. **Command scopes.** Writes into a scope the same intent creates (a command that copies into a
    new tree) are applied after step 15 creates it, and take that scope's seq and digest. A copied
    minted or derived record takes its alive source's life, and `born :=` that life's stamp (a
    create, §4.1), so a revived source's copy keeps its life.
15. **Lifecycle.**
    - A governing create inserts `sync_scopes(tree:<id>, alive, seq 0, digest 0)`.
    - A governing death marks `tree:<id>` and every `acct:*/overlay/<id>` dead, with `dead_at`.
    - An overlay row stores `governed_by = tree:<id>`. These scope rows are locked in this order:
      `tree:<id>`, then overlays in ascending key order.
16. **Result.** `ok {seq: scope.seq, write?, detail?}`. A command's result always carries `write`,
    its write map, possibly empty.
    - Replica origin: upsert `sync_results(replica, n, digest, result)` and set `last_n := n`.
    - Server origin with a `requestId`: store the result as the call's part `requestId#k` (§6.3).
17. **`COMMIT`.** Publish the live frames (§6.8), then release the mutex.

**Step R.**
1. `ROLLBACK`.
2. In a new transaction, write the result as step 16 does. Only a replica origin first locks its
   replica row (a server origin has none) and re-checks it as step 3.3 does.

The scope mutex is held until step R's transaction, or a fault path's (§6.6), ends.

**Exceptions**, in steps 1–17 and in step R's transaction alike, are classified by §6.6.

### §6.2 Push

`POST /v1/sync/push` (§9.3):

1. **Envelope,** in §9.1's order: no credential, or one that does not resolve → `401`; a body over
   `PUSH_MAX_BYTES` → `413`; a body other than exactly `{replica, account, ackThrough, intents}`, a
   `replica` not of D-3's form, an `account` that is not a string, an `ackThrough` that is not a
   safe integer ≥ 0, or an intent without a safe integer `n ≥ 1` → `400 malformed`; more than
   `PUSH_MAX_INTENTS` intents → `413`.
2. **Epoch.** The response carries the current epoch.
3. **Bind.** A push names the account its replica is bound to, or is binding to. One whose `account`
   is not the account it is served as → `409 account-mismatch`, before the binding is read: nothing
   is bound or admitted. Otherwise a replica bound to another account → `409 replica-foreign`. An
   absent `sync_replicas[replica]` is inserted, bound to the account the push names, with
   `last_n = 0`. A push that inserted the binding and answers `409` deletes it, under the replica
   row lock, while its `last_n` is still 0 and the replica holds no `sync_results` row; an admission
   that finds its binding gone inserts it again (§6.1 step 3.3).
4. **Take intents in ascending `n`,** each compared with `last_n` as read under the replica row lock
   (§6.1 step 3.3), never with a value read earlier in the request, so an intent that an overlapping
   push of the same replica admitted meanwhile is answered from its stored result, never as a gap:
   - `n ≤ last_n`: no stored row, or a digest ≠ `digest(intent)` → `409 replica-forked` (stop).
     Otherwise answer the stored result.
   - `n > last_n + 1` → `409 gap` (stop).
   - Otherwise `admit`.
5. **Bound the work.** Once the request has admitted an intent and `PUSH_WORK_MS` have passed, stop
   and return `retry {n, retryAfterMs: 0}` naming the first unprocessed intent. An answer from
   `sync_results` is not an admission.
6. **Prune.** In a request answered `200`, delete this replica's `sync_results` rows with
   `n ≤ min(ackThrough, last_n)`.

`digest(intent) = sha256(jcs(intent))`. A client never resends an `n` whose result it recorded, so
a missing row for `n ≤ last_n` means the store was forked or restored.

### §6.3 Server-origin writes

MCP tools, REST writes, tending and server-internal commands call
`admit(server(A, requestId?), intent)`.

- **With a `requestId`,** dedupe is per tool call, with `digest = sha256(jcs({tool, args}))`. A
  `requestId` is a non-empty string holding neither `#` nor U+0000; any other → `invalid`, and
  nothing is stored.
  1. Every admit the call runs takes `pg_advisory_xact_lock(A, requestId)` (§6.1 step 3.3) and sets
     `started_at := now`. Before its first intent the call looks up `sync_requests(A, requestId)`
     under that lock, in the transaction of the first admit it runs, or of its final write (step 3)
     when it runs none: a final result with the same digest → return it; a different digest →
     `request-conflict`; `running` younger than `REQUEST_LEASE_MS` → `request-running` (retry
     later); `running` older than that → the call takes the lease over (`started_at := now`) and
     resumes from its stored parts (step 2). The takeover so rolls back with a transient failure of
     that admit. The first admit's transaction stores the row as `running`.
  2. The call's k-th admit stores its result as the part `requestId#k` in its own transaction,
     including every output a later admit needs (such as a minted id). A part already stored is
     replayed: the call runs no admit for it and writes nothing, and rebuilds later admits from its
     outputs.
  3. After its last part the call writes its result into the row, `done`, in a transaction of its
     own. A crash before that write leaves the row `running`, and a retry after the lease replays
     every stored part, then writes the result. An admit that faults (§6.6) ends the call `refused
     internal`: its part and the row store that result, `done`, in one transaction.
  4. Every intent of one call carries the same `gestureId`: the `requestId`, or a server-minted id.
- **Without a `requestId`:** no deduplication.
- A call's admits run in order and stop at the first refusal, which is the call's result; otherwise
  its result is its last admit's. A resumed call stops alike at a replayed part that is a refusal
  (step 2).
- A transient failure (§6.6) of the call's first admit leaves no row: the transaction that would
  store it rolls back. A transient failure of a later admit leaves the row `running`, so a retry
  within `REQUEST_LEASE_MS` answers `request-running`.
- **Builders** that read records (sibling order, derived ids, whole-graph edits) read under the
  scope lock, from rows or from a cache whose seq equals `scope.seq`.
- **Server-built bulk writes** classify each incoming id as create, update or spent before building
  deltas, and report spent ids to the caller.

### §6.4 Commands

`handler(txn, ctx, args) → {deltas, write, detail} | refuse(code)`:
- It is deterministic given the locked rows, `args` and `serverNow`.
- It MAY lock more rows through the ports, and MAY write any field.
- It resolves its own replays (Appendix A), comparing the raw arguments stored with its receipt,
  before the guards are checked (§6.1 step 7).
- A command not in the registry is refused `invalid`.

### §6.5 Caps

`sync_scopes.counters[type]` equals the number of alive records of the type in the scope, and is
kept for capped types only. A new scope's counters are 0, an absent key reading 0, and only step 13
changes them. The cap check reads the counter and never counts rows. `holdsRecords` (§9.2) needs no
counter: it is an existence query over visible rows of primary types.

### §6.6 Faults and poison

- **Transient:** connection failure, pool exhaustion, a mutex or `lock_timeout` timeout,
  serialization failure, deadlock or shutdown. Roll back, record nothing, stop the request, and
  return the results so far with `retry {n, retryAfterMs: 1000}`. A transient failure before the
  push takes its first intent, in the bind (§6.2 step 3) included, answers `503 unavailable` with
  `retryAfterMs: 1000` instead.
- **Fault:** any other exception, including `statement_timeout`.
  1. Roll back.
  2. In a new transaction that locks the replica row and re-checks it as §6.1 step 3.3 does, upsert
     `sync_results(replica, n, digest, null, faults + 1)`.
  3. At `faults ≥ K_POISON`, store `refused internal` and set `last_n := n`.
  4. Otherwise stop the request with `retry {n, retryAfterMs: 0}`.
- A server-origin admit that faults answers its caller `refused internal` (§6.3), final at its first
  fault: its caller holds no queue to retry it. Only a replica's intent is attempted up to `K_POISON`
  times.

### §6.7 Pull

`POST /v1/sync/pull` (§9.4). A pull whose credential does not resolve answers `401` before anything
else, and runs no `beforePull` (§9.1). A request names at most `PULL_MAX_SCOPES` scopes; more → `400
malformed`, and a body over `PULL_MAX_BYTES` → `413` (§9.1). Each requested scope is served from one
read-only `REPEATABLE READ` transaction, so its access check, its rows (`feed` and `sync_spent`
alike), its `seq` and its scope digest all come from one snapshot:

1. **Access**, as §6.1 step 3's refusals, read in the snapshot without row locks and without
   creating a scope:
   - `not-found`: absent; or no read access; or dead, to a non-owner.
   - `gone`: dead, to its owner. An overlay answers as its tree does: `gone` only to the tree's
     owner.
2. **Reset.** An undecodable cursor (§9.4), `cursor.epoch ≠ epoch` or `cursor.seq > scope.seq` →
   `reset`, an absent scope's seq being 0. Then an absent product scope, or an absent overlay of a
   readable alive tree, answers an empty live page at seq 0 with digest 0, whatever the cursor.
   `cursor = null` → boot with `asOf := scope.seq`.
3. **Boot page.**
   - Rows with `seq ≤ asOf` and `(seq, type, id) > (cursor.seq, cursor.key)`, in that order, from
     every type's `feed` merged with `sync_spent`, both read in the snapshot.
   - Keep a row iff it has no life, it is alive, or its type is `derived`. A dead derived row is
     sent thin: `{t, id, life, born, seq}`.
   - Up to `PULL_PAGE_BYTES`, with at least one row. When the scan is exhausted the cursor becomes
     `{live, seq: asOf}`.
   - The page carries `total`: the rows with `seq ≤ asOf` that the boot keeps, counted in the
     snapshot, for progress. It can fall between pages, as rows move above `asOf`.
4. **Live page.**
   - Every row with `(seq, type, id) > (cursor.seq, cursor.key)`. Dead rows are thin (`{t, id,
     life, born?, seq}`; a keyed type's has no born).
   - The cursor becomes `{live, last seq}`, plus the last key when the page ends inside a seq. A
     page with no rows keeps the cursor's seq and drops its key.
   - `more` is false iff the cursor after the page is live, carries no key and is at the scope's
     seq.
5. **Head.** A rows page carries the scope's `seq` and scope digest (§6.12) as the snapshot holds
   them, so they describe exactly the state its rows come from.
6. **Header.** A `tree:<T>` page carries `header = {owner: {name}}`.

Before a scope is pulled, each `beforePull` command of its scope (§2.4) runs in its own admission,
with the server origin of the scope's owner (`server(owner)`), and commits before the pull's
snapshot is taken. An absent scope runs none.

### §6.8 Live push

At step 17, after the commit and before the scope mutex is released, the server publishes
`{op: change, scope, epoch, seq, digest, rows}` at once, with no debounce, to every socket
subscribed to the scope that still holds read access. Frames of one scope so leave in seq order.
`digest` is the scope digest committed with `seq`.
- `rows` is omitted when the `jcs` of the rows array exceeds `LIVE_INLINE_BYTES`.
- A scope that dies sends each subscriber the page kind a pull of it would answer (§6.7 step 1):
  `gone` to the tree's owner, for the tree and for that owner's overlay, and `not-found` to
  everyone else. An overlay never written was never created (§6.1 step 3.5), so a tree's death
  sends no frame for it.
- An upgrade whose credential does not resolve answers `401` (§9.1). A socket keeps the principal
  its upgrade was served as, and every frame it sends carries it as `as` (§9.5).
- A `sub` to a scope its principal cannot read is answered at once with the `gone` or `not-found`
  a pull would give, and is not kept.
- A visibility change that removes a subscriber's access sends `not-found` and ends that
  subscription.
- The per-socket access check MUST use in-memory state, invalidated by every write to an `opens`
  field, by scope death, and by the revocation of the socket's credential. A socket whose credential
  is revoked or expires is closed before it sends another frame or answers another `sub`: it never
  goes on as anonymous.
- A deployment with several server processes MUST relay committed changes to every process holding
  subscribers.

### §6.9 Projections and read caches

`apply` MAY write derived rows in the admitting transaction. Appendix A lists them. A read cache
MUST be keyed by `(scope, seq)` and MUST NOT answer an admission.

### §6.10 Retention and GC

- **G1.** A non-revivable record that dies loses its fields: lattice, text and serial values alike.
  Its row is deleted (`deadRows: spent`, with `sync_spent` keeping it) or thinned (`deadRows:
  keep`). Revivable dead rows keep their fields.
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
   - Else → `diff3(base, head, mine)`. Each of its edit scripts, base → head and base → mine,
     takes `(base tokens + 1) × (side tokens + 1)` cells. When either would take more than
     `MERGE_WORK_CELLS`, no script is computed: the whole text is one conflict region, emitting
     `rtrim(head) + "\n\n" + ltrim(mine)`, so `merged` becomes true. Step 3 applies to it as to
     any result.
3. **Cap.** A result over the field's `max` → `too-large`. A text field's bound applies to this
   result only, so a text over it is never `invalid` (§6.1 step 2).
4. **Store.** A result whose text and `merged` both equal the stored ones changes nothing. Otherwise
   the previous head goes to the revision table under its rev, and the new rev is this intent's seq.
   `merged := conflict ∨ (merged ∧ baseText ≠ headText)`, where `conflict` means a region emitted
   both sides. A change of `merged` alone is a change.

`diff3(base, head, mine)`:
- **Tokens:** maximal runs of whitespace (ECMAScript `\s`) and of non-whitespace.
- **Scripts:** `base→head` and `base→mine` are each the lexicographically least shortest edit script
  under keep < delete < insert: equal tokens are kept as early as possible, and a deletion precedes
  an insertion.
- **Hunks:** each script's maximal runs of deletions and insertions, as base ranges with their
  replacement tokens. A hunk is *whitespace-only* when every token it deletes or inserts is
  whitespace.
- **Regions:** hunks chain into one region when their base ranges overlap or touch. Base tokens
  outside every region are emitted once. With `H` and `M` the region's text after head's and mine's
  hunks, a region emits:
  - the changed side's text, when only one side has hunks in it;
  - `H`, when `H = M`;
  - `H`, when every hunk of both sides is whitespace-only;
  - the other side's text, when every hunk of one side is whitespace-only;
  - the other side's text, when `H` or `M` is empty;
  - otherwise a conflict: `rtrim(H) + "\n\n" + ltrim(M)`.

  A whitespace-only hunk so never conflicts, and edits to neighbouring words, which a whitespace
  token separates, merge without one.

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
change is such a transaction: replica and server-origin admission, every command (`beforePull`
commands included), and a command's writes into a scope it creates (§6.1 step 14). Every referential
consequence (§2.2) is a change of step 13, and a derived row that `apply` writes (§6.9) is never a
`feed` row. A governing create starts its scope at digest 0. Scope death changes no row, and a dead
scope's digest is never sent; G5 sets it to 0. A restore brings it back with its rows. A pull reads
the stored digest and never sums rows.

**Client.** The client keeps the same sum over its confirmed rows, hashing each row as received,
and checks it against the server's (§7.5). It MAY store each row's hash beside the row. Pending
entries and predictions never enter it.

---

## §7 Client algorithms

### §7.1 `commit(scope, changes, opts) → {localIds, retired, stamp} | Refused | none`

`opts = {atomic, hold, guard, retire, cmd, predict, local, gestureId}`. `commit` is a synchronous
call on the local store. It MUST NOT be launched from a cancellable UI scope, and never awaits the
network. It throws only before its local transaction commits, and every client API declares exactly
three failures, told apart by where they arise:
- *not writable*: step 1, the replica's state forbids writes;
- *malformed*, a programming error: every throw of steps 2 to 10, the checks before step 2 included
  (a type outside the commit's scope, an `opts.gestureId` that an outbox entry or a notice of any
  replica on the device already carries), and every misuse of what the read-and-commit function is
  given: a reference that is not this commit's scope, a view read or an id minted after the function
  returned, or an id minted for a type that mints none;
- *store failure*: anything else. The transaction could not commit, and nothing is written.

An error the read-and-commit function itself throws is none of the three: `commit` writes nothing
and rethrows it unchanged.

A `Refused` is a result, not a failure. Once the transaction has committed, `commit` MUST return its
result: a failure in the steps after the commit (below) is the engine's to log and retry, and never
reaches the caller.

In the **read-and-commit** form, `changes` is a function of the views: `commit` calls it after step 1
and before step 2, with `drawn` and `stored` read inside the same transaction and the commit's
`physNow()` reading (step 4), so a read and the writes it decides are one transaction. The function
returns the gesture (its changes and `opts`) or none, and MAY return a value of its own, which
`commit` returns beside its result. With none, `commit` writes nothing, ticks no clock and returns
none. A gesture whose diff is empty still runs steps 2–11. One local transaction:

1. **Writable replica.** The replica is `anon` or `bound`; otherwise throw (not writable).
2. **Scope check.** For `tree/<T>` and `self/overlay/<T>`: if the governing record `T` is dead in
   `stored`, or the scope is known `gone` or `not-found` (`KnownScope`, §7.5), return
   `Refused(scope-dead)` and write nothing. A death that only a boot reveals is not known, since a
   boot sends no dead minted rows: the write is committed, and the server refuses it `scope-dead`
   with a notice.
3. **Stamp.** Read `meta.hlc`, `observe(hlcHigh)` and `s := tick()`. `s` is the gesture's stamp;
   each entry keeps it as `stamp`, and `commit` returns it as `stamp`. The clock is written back
   only when the commit is accepted (step 11); a refused commit writes no clock.
4. **Retire, then deltas.** First the retire: `retire` lists records `(t, id)`, and every held
   gesture of the scope that carries no command, and whose every delta removes (`life → dead`) one
   of them, ends `undone`, as `undo` ends it, its dependents folded silently (§7.3). `commit` returns
   their gesture ids as `retired`, in commit order; a commit refused at step 8 retires nothing. A
   retired removal never happened, so the record keeps its untouched fields, and a minted or derived
   record is back in `drawn`: the gesture writes it by an update. From here on `drawn` and `stored`
   hold neither the retired entries nor the parts their fold removes. Then diff `changes` against
   `drawn`, emitting only changed fields, stamped `s`:
   - A minted or derived delta carries the record's `born`. A create gets `born = s` and
     `life = [alive, s]`.
   - A create of an id already in `drawn` is dropped, after its anchor, if any, is checked.
   - A keyed-with-life put's life:
     - `[alive, s]` when the gesture makes the record present, and for a `wholePut` type whenever
       the put leaves it present;
     - `[dead, s]` when it removes it;
     - otherwise the drawn life register, unchanged.
   - A put that leaves a `wholePut` record present writes every client-written lattice field of its
     type, changed or not, stamped `s`; a change that leaves one out throws.
   - A revive takes `born` from `drawn` or from `SpentId`.
   - An update or delete of a record absent from `drawn` throws.
   - A create or a move MAY carry an *anchor* `{field, below}`: an order field (D-25), and the
     record above the drop point or none for the top. An anchored create and a move take D-25's
     drop position, with `below` looked up in `drawn`, then in `stored`. A move writes only `field`,
     by an update; a move and an update of one record in one gesture fold into that one update, and
     the update writing `field` throws. An anchor absent from both views throws, and so does a value
     for `field` beside an anchor.
   - A created record's client-written `time` fields that the change leaves unset take `physNow()`.
     A commit reads `physNow()` once: the read-and-commit function, step 3's `tick` and these fields
     all take that one reading. A field that records each save's own moment is an `lww` field, not
     a `time` one (which joins as `const` and keeps its first value): the product writes it from the
     `now` the read-and-commit function receives.
   - A number, at any depth of a field value or of a command argument, is rounded to its domain's
     `quantum` `q`, in IEEE-754 doubles, with
     `roundHalfAway(y) = sign(y) × round(|y|)`: `roundHalfAway(x / q) × q` for an integer `q`, and
     otherwise `roundHalfAway(x × k) / k` with `k = round(1 / q)`. A number is on its quantum iff
     this rounding leaves it unchanged; the server admits only such numbers (§6.1 step 2).
   - A text change names the text it was edited from. The entry keeps that text in `baseTexts`.
     The delta's base is `{rev}` when that text is the confirmed text at that rev; otherwise
     `{text}`.
5. **Ids.** Minted ids come from a CSPRNG by the type's `mint`, or are seeded (D-8). Label-based
   derived ids come from `derive` (D-26).
6. **Guards.** `guard` lists registers `(t, id, field)`, and guards exactly those: each becomes
   `(t, id, field, its stamp in stored)`, null when unset (D-19). Each listed field MUST be a
   lattice field of a type the commit's scope holds; any other throws: `life`, a text field, an
   undeclared field, or a field of a type another scope holds. A text field is never guarded: it
   has no stamp, and merges instead (§6.11).
7. **Group.** `atomic`, `hold` or `cmd` → one intent; otherwise one intent per record. An intent
   changes a record at most once: changes that give one record two deltas, other than the move and
   update step 4 folds, throw. Each guard goes with the intent that writes its record; a guard on a
   record no delta writes goes with the first intent. The gesture id is `opts.gestureId`, or one
   `commit` mints with at least 122 bits from a CSPRNG, unique on the device without a check. The
   k-th intent's entry has `localId = <gestureId>/<k>`. An intent exists only if it carries a delta
   or a command: guards are dropped when the gesture has neither, and a gesture with nothing to send
   enqueues nothing (held or not), so no retire can match it. A string of the intents (their scope,
   deltas, guards, command and gesture id), a key or a value at any depth, that holds U+0000 throws,
   as §6.1 step 2 refuses it.
8. **Caps and size.**
   - A gesture whose deltas, applied to `stored`, raise a capped type's visible count above its cap
     by the growth rule (§6.1 step 12) returns `Refused(cap)` with detail `{type, cap}`, as §6.1
     step 12 gives it, and writes nothing. The gesture's command prediction is not counted. Held
     deletes still occupy their slots (§7.6).
   - If any intent, pushed alone, would make a request body over `PUSH_MAX_BYTES`, the whole gesture
     is refused: nothing is enqueued and no clock is written, a notice `notice:<gestureId>/0` holds
     the gesture's content, and `commit` returns `Refused(too-large)`. The body is measured as the
     sender encodes it (§7.4), `jcs({replica, account, ackThrough, intents: [intent]})`, with `n`
     and `ackThrough` at their widest, 2^53 − 1, and `account` the replica's, or, in the `anon`
     replica, a string of `ACCOUNT_ID_BYTES` bytes that `jcs` prints unescaped. An entry as
     committed so always fits a request alone; §7.4 refuses one that grew past it.
9. **Enqueue.** Each entry takes lineage A in a `bound(A)` replica, and `anon` in the `anon` replica
   (D-27).
   - `hold` → `held` with `releaseAt = deviceNow + HOLD_MS`.
   - Otherwise `ready`.
10. **Device rows.** Write `opts.local` rows into `device/<product>`. A commit with only local rows
    is legal. A key that matches no device row of the product's registry (`keyPattern`) throws.
11. **Clock.** Write `meta.hlc` back, and `hlcHigh := s`.

After the commit: notify tabs (§7.8), kick the sender, and schedule release timers.

### §7.2 Send order

Every committed gesture is sent as its own entries, in commit order: `commit` enqueues one entry per
intent (§7.1 step 7), and the sender numbers ready entries in commit order, passing over held and
held-back entries (§7.4). Before its result, an entry changes only by a fold (§7.3, §7.7 step 3), a
restamp or a write map (§7.7).

### §7.3 Hold, release, undo

```
release(entry): tx: if entry.state = held → state := ready; kick the sender
undo(gestureId): tx: if every entry of the gesture is held → delete them, fold their dependents
                 silently (below), return true; else return false
```

**Silent fold.** An undo and a retire (§7.1 step 4) fold the dependents (§7.7 step 3) of the entries
they end silently, in the same local transaction, with no notice: in every later held or ready entry,
the dependent deltas are removed, with the guards on their records, and a dependent command with its
prediction. An entry left empty ends `undone`. A dependent of a held entry is never numbered (§7.4),
so a silent fold never meets a sent entry.

- Release runs in every replica state.
- **Triggers:**
  - an in-process timer at `releaseAt`, owned by the app or process (on web, a timer in every tab);
  - **leaving the app** releases every held entry into the durable queue at once, and the sender
    attempts one best-effort push at once, whatever backoff is running, unless a server-requested
    wait is running (§7.4); that push neither resets k nor ends the backoff. Leaving is the process-
    or scene-level signal: Android `ProcessLifecycleOwner` `ON_STOP`, iOS scene `.background` of the
    last foreground scene, and on web no tab of the app visible, debounced, or the last tab's
    `pagehide`. A tab that becomes hidden decides after `LEAVE_DEBOUNCE_MS`, and leaves only if no
    tab has announced it is visible by then (§7.8). A page suspended before `LEAVE_DEBOUNCE_MS`
    elapses releases on its next resume or `pagehide`; the hold is durable either way. The push of
    the last tab's `pagehide` SHOULD number the ready entries and send them with `fetch(keepalive)`,
    up to `KEEPALIVE_BYTES`. A reload is a `pagehide`;
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
  tx: number ready entries in commitOrder, up to PUSH_MAX_INTENTS, and while the request body stays
      within PUSH_MAX_BYTES (the first entry of a request always goes), passing over held-back
      entries, and stopping after the first command entry or at a held-back command entry:
      n := nextN++, digest, state := sent
          (no entry is numbered while a command entry is `sent`)
      an entry whose one-intent body, at that n and the current ackThrough, exceeds PUSH_MAX_BYTES
          is not numbered: it grew after commit (a restamp adds digits, a write map lengthens an
          id), so it ends `refused` `too-large` by §7.7, with its notice (an orphan with none of
          its own), and its dependents fold
  POST push jcs({ replica, account, ackThrough, intents: sent entries by n })
      // the body is its jcs
  network error                 → backoff
  503 {retryAfterMs}            → sleep max(retryAfterMs, the backoff draw)
  retry {n, retryAfterMs}       → entries from n stay sent (unless §7.7 step 1.3 returned them to
                                  ready: it takes precedence); wait, then continue
  401, account-mismatch, or a 200 or 409 served as another principal (§9.1)
                                → authPaused := true (no retry consumed), nothing applied
  426                           → stop until upgraded
  400 or 413, several intents   → halve the batch: resend its first ⌈count/2⌉ entries by n
  400 or 413, one intent        → nextN := its n, every later sent entry returns to ready, and the
                                  entry is refused by §7.7 (400: invalid, 413: too-large) with its
                                  notice; an orphan ends without its own (its content rides its
                                  origin's notice), and dependents fold transitively
  every 400                     → also emit the telemetry event sync-push-malformed, with no intent
                                  content
  replica-forked | replica-foreign | gap → re-identify (§7.11)
  per result, in its own tx:
    ok      → acked, resultSeq := seq, resultEpoch := the response epoch; apply the write map (§7.7)
    refused → §7.7; after a `clock-skew` recovery, back off before the next push
    ackThrough := the response's lastN, once its results are recorded
  then, if the response epoch ≠ serverEpoch → epoch change (§7.5)
backoff: sleep random(0, min(ceiling, 1 s · 2^k)), then k += 1; ceiling = liveHint ? 30 s : 300 s; k resets
         on a response with results, unless one of them is `clock-skew`
         (liveHint: computed now by the product's view rule, Appendix A)
kick (wake now, k := 0): commit, release, undo, connectivity change, foreground, auth refresh; a kick
         never cuts short, or resets k during, the backoff after a clock-skew recovery
server-requested wait: a 503's or a retry's retryAfterMs, from the response's receipt; no push
         starts before it ends: a kick wakes the sender no earlier, and a leave (§7.3) attempts no
         push during it
```

A ready entry is *held back* while it depends (§7.7 step 3) on a held or held-back entry or on an
orphan awaiting its result (sent, or returned to ready), or touches, by a delta, a guard or a
prediction, a record that an earlier held-back entry touches. Every other ready entry is numbered
past held and held-back entries.

### §7.5 Puller, reset and epoch change

The puller runs on start, foreground, reconnect, a live gap, a subscribe (§7.9), a
re-authentication that clears `authPaused` (§8.2), and every `PULL_FALLBACK_MS`. Each run pulls the
scopes of its trigger, each until `more = false`: a live gap its scope, a subscribe the scope
subscribed, and every other trigger every subscribed scope. A request names at most
`PULL_MAX_SCOPES` scopes; a run over more sends several, and a run left with no scope to pull
(every one waiting, §7.9) sends none. Each run first reconciles the subscription set (§7.9). A pull
answered `401`, or served as another principal (§9.1), sets `authPaused` and applies nothing (§9.6).

**Live socket.** A replica that pulls keeps one live socket, subscribed (`sub`) to the scopes it
pulls. An open that fails, and a socket that ends or fails (the server or the network closes it, or
a `ping` goes unanswered), count as a reconnect: the puller runs at once. A close the client makes
(leaving the foreground, going offline, a replica change) pulls nothing. Opening again backs off as
the sender does (§7.4), with its own `k` and the 30 s ceiling: `k` rises with every failed open or
ended socket, and resets once a socket has stayed open 30 s. A `401` at the upgrade, where the
client can read it, sets `authPaused` too; a browser, which cannot, learns it from its next pull or
push. A frame served as another principal (§9.1) sets `authPaused`, applies nothing, and the client
closes the socket. A re-authentication that clears `authPaused` opens the socket again at once, with
`k := 0`. A `426` from any request stops sync until the app is upgraded (§9.6), on every tab (§7.8).

1. Update the offset (§10.4) before observing any stamp. A null `serverEpoch` takes the response
   epoch. A response epoch ≠ a non-null `serverEpoch` triggers an **epoch change** first. In one
   transaction:
   1. `serverEpoch := epoch`.
   2. Every cursor becomes `null`, and every staging is dropped.
   3. Every `acked` entry with `resultEpoch ≠ epoch` returns to `ready` at its commit position.
   4. Re-identify (§7.11).

   A restore is outside INV-3's condition. For example, a re-sent command may create its record
   again under a new `born`, and a pending delete already rewritten to the old `born` then ends as
   a no-op; and a notice may describe a record that a forked store later re-creates.
2. Per page, in one local transaction:
   - **Stale page.** A page requested with a cursor other than the scope's stored cursor is dropped,
     and the scope is pulled again, so a cursor never moves backwards.
   - **`reset`:** the cursor becomes `null`, and any staging is dropped.
   - **Boot rows** go to staging when the boot starts from a `null` cursor while confirmed rows
     exist, otherwise straight in. A thin dead derived row adds a `SpentId`. On the page that ends
     the boot's scan (its cursor turns live):
     - staging replaces the scope's confirmed rows, and its digest replaces theirs;
     - `booted := true`;
     - acked entries of the scope with `resultEpoch = serverEpoch` and `resultSeq ≤ asOf` resolve.
   - **Live rows** replace confirmed rows by §3.4; a dead row deletes it, a dead derived row also
     adds a `SpentId`, and a dead row of a governing type records its `tree/<id>` and
     `self/overlay/<id>` as known `gone` (`KnownScope`).
   - **`gone` or `not-found`**, except two the client ignores, forgetting and recording nothing:
     - Any for a product scope. The server answers one only to a request served as anonymous, which
       the client has already handled as a `401` (§9.1), so no described path reaches this ignore
       for a bound replica: it is defence in depth, and stays. It hides no genuine end, since a
       product scope never dies: a deleted account's credential stops resolving (`401`); a product
       scope the server does not hold answers `reset` to a cursor past seq 0 and then an empty live
       page, so the client boots it empty (§6.7 step 2); and a product the registry drops is a
       version change (`426`, §2.4).
     - A `not-found` for a scope waiting for its governing record's create (§7.9).

     Otherwise:
     - delete the scope's confirmed rows, `SpentId` rows and cursor, record the scope as known with
       that kind, and unsubscribe;
     - acked entries of the scope resolve;
     - pending entries stay, and the server refuses them.
   - A rows page clears the scope's `KnownScope` record. Only it, a subscribe and an alive governing
     row (§7.9) clear one, the last two only a `not-found` one.
   - Every change to the scope's confirmed rows changes `CursorRec.digest`, and every change to its
     staging changes the staging digest (§6.12).
   - Store the cursor, observe every stamp, update `admittedHigh`.
   - Resolve acked entries whose `resultSeq ≤ cleanSeq` in the same epoch.
     - Live cursor: `cleanSeq = cursor.seq`, or `cursor.seq − 1` while the cursor carries a key.
     - While booting: `cleanSeq = −∞`.

   An `ok` whose `resultSeq` the scope's `cleanSeq` already covers, in the same epoch, resolves its
   entry in the result's own transaction (§7.4).
3. **Live frames.** A `change` frame is applied as a live page iff the cursor is live without a key,
   `epoch` matches, `seq = cursor.seq + 1`, and `rows` is present. Otherwise pull. A `gone` or
   `not-found` frame is applied as that page kind, and the two a page ignores (step 2) are ignored
   alike.
4. **Digest check.** When, after a page or frame is applied, the cursor is live, carries no key and
   its seq equals the page's or frame's `seq`, and no staging is pending, the client compares its
   digest with the received one, in that transaction. This covers a live page that reaches the head,
   a frame applied inline, and a boot whose `asOf` scan has ended and caught up to the head. On a
   mismatch:
   1. emit the telemetry event `sync-digest-mismatch`, with the scope kind and seq and no row
      content;
   2. reset the scope: the cursor becomes `null`, `mismatchReset := true`, and the next pull boots
      it into staging (step 2). The outbox is untouched.

   A matching check clears `mismatchReset`. When a check mismatches while `mismatchReset` is set,
   the client emits the event once more, clears `mismatchReset`, and stops checking that scope,
   recording the app version in `CursorRec.digestStop`; checks resume when the app version changes.

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
- Unknown fields, and rows of unknown types, are preserved and ignored: a row of an unknown type is
  never visible, and a record of a type with life is visible only while alive.
- Appendix A may add a product view rule (A.2).

### §7.7 Refusal, rebase, recovery and maps

On `refused(code)` for entry `e`, in one local transaction (an orphan's refusal ends it without a
notice of its own, as step 3 states):

1. **Automatic recovery,** which writes no notice. `e` returns to `ready` at its commit position:
   - `clock-skew`:
     1. Update the offset.
     2. `hlc :=` the pair maximum of `(physNow(), 0)` and `admittedHigh`.
     3. Every later `sent` entry with `n` above the response's `lastN` returns to `ready`, and
        `nextN := lastN + 1` (the server never processed those numbers).
     4. Restamp `e`, and every held and ready entry, in commit order, by the restamp rule below.
        Predictions are not restamped.
     5. `meta.hlc` and `hlcHigh` become `max(admittedHigh, the new stamps)`, shared by every tab.
   - `base-unknown`: every text delta of `e` switches to `base: {text: baseTexts[…]}`.
2. **Remove `e`.**
3. **Fold dependents.** A *dependent* is a delta or command of a later entry that touches, or whose
   `ref` fields, `ref` arguments or key parts name, a record created in `e` (by a delta or by
   `predict`), that carries unchanged a life register `e` wrote (a keyed put, §7.1 step 4), or that
   targets a scope whose governing record `e` creates. A reference names a record in the scope its
   type lives in: a product scope, or the tree and overlay scopes of the same tree. Folding is
   transitive: a record a dependent creates, and a life register it writes, make their own
   dependents. A guard makes nothing dependent, so a fold keeps a guard on a record `e` creates in
   an entry with no dependent delta on that record. After this refusal the server refuses that entry
   `stale` (§6.1 step 7), the register it names never having been written. A guard on a register of
   a record a held entry creates names no stamp, unless a held-back entry wrote that register first:
   guards read `stored` (§7.1 step 6), which holds held-back entries and no held ones. After an undo
   or a retire (§7.3) the guard holds in the first case, and in the second the fold empties that
   writer and the server refuses the guarding entry `stale`.
   - In a held or ready entry, the dependent deltas are removed, with the guards on their records,
     and a dependent command with its prediction. An entry left empty ends `refused`, in this
     notice.
   - A `sent` entry with a dependent part is an *orphan*: it is marked `orphanOf = e`. Its `ok`
     makes it `acked` like any `ok`, and does not withdraw its content from the notice; its refusal
     ends it `refused`, with no notice of its own. An orphan's whole content is a source: every
     record it creates and every life register it writes make their own dependents. They are held
     back (§7.4) until its result: on `ok` they are numbered as usual; on a refusal they fold by this
     step into `e`'s notice, and a sent one becomes an orphan of `e`.
4. **Notice.** Write the notice `notice:<localId of e>` with `e`'s content, and in `dependents` each
   dependent entry's removed or orphaned content (INV-3). A notice's content is a snapshot: no later
   recovery, restamp or write map changes it.
5. **Redraw.** Recompute the touched views. This is the whole rebase; clients re-execute no
   business logic.

**Write map.** An `ok` result's write map applies in the result's transaction. Let `s` be the
command entry's stamp, which every register it predicted carries. Steps 1 and 2 run for each map
entry `w`, then step 3 once for the map:
1. `w.from` is present only when the resolved id differs from the id the command was called with,
   which means the record existed before the command (a join). It is replaced by `w.id` in every
   held and ready entry (delta ids, key parts, `ref<w.t>` fields and arguments), in `predict`, and
   in device rows (a product hook). The exception is an entry whose delta deletes `(w.t, w.from)`:
   it is not rewritten, and is refused `target-merged` by steps 2–4 above.
2. The command's own `predict` is restamped by the restamp rule, with `n` given by the map:
   `w.f[f]` for each field, and `w.born` for the life of a record it created or resolved to. Later
   borns and guards naming the stamps its predicted registers carry follow. The predict stays
   drawn until the cursor covers `resultSeq`.
3. The client observes every stamp in the map and raises `admittedHigh` to them. Then it restamps,
   by the restamp rule with fresh ticks, the registers the map names (a field in `w.f`, or the life
   of a `w` with `born`) in every held or ready entry that writes them. A later local write
   therefore follows the command it came after (INV-1).

No entry is `sent` behind a command (§7.4), so every reference, born and guard is rewritable.

**Restamp rule.** Used by `clock-skew` recovery and by the write map (steps 2 and 3). It moves only
registers an entry wrote, which carry a stamp at or after the entry's `stamp`. A register an entry
carries unchanged (a keyed put's drawn life, §7.1 step 4) moves only with its source. The registers
each entry wrote are determined for every entry before any register moves in a pass. Each restamped
entry takes one new stamp `n`: a fresh tick of the recovering instance's clock, in commit order, or
the stamp a write map gives. In `clock-skew` recovery `n` becomes the entry's `stamp`; a write-map
restamp leaves the entry's `stamp` unchanged. For each register that moves from `o` to `n`:
1. the register takes `n`;
2. if it is a create's life, the entry's `born` also becomes `n`, and every later held, ready or
   sent delta on the same `(t, id)` carrying `born = o` takes `n`;
3. every later held, ready or sent delta on the same `(t, id)` carrying that life register
   unchanged at `o` takes `n`;
4. every later held, ready or sent guard on that register naming `o` takes `n`.

A later `sent` entry so recovers from its own `clock-skew` refusal with borns and guards that match.
A process death between two result transactions of one response can leave such an entry rewritten
before its own result is recorded; its resend then carries another digest, the server answers
`replica-forked`, and the replica re-identifies (§7.11), with nothing lost.

### §7.8 Multi-tab (web)

- The leader holds `navigator.locks` lock `wm-sync:<replica>` and runs the sender, the puller and
  the live socket.
- A tab requests the lock when it becomes visible. A hidden tab releases it once a peer announces
  it is visible.
- Tabs post `hello {visible}`, `visible`, `hidden`, `bye`, `changed(scope, ids)` and `upgrade` on
  `BroadcastChannel('wm-sync:<replica>')`, and a tab answers a peer's `hello` with its own. A tab
  that knows no other live tab is the last tab. A tab that receives a `426` posts `upgrade`, and
  every tab then stops sync until the app is upgraded (§7.5).
- Every tab holds the lock `wm-tab` in shared mode while it lives. A tab that finds it unheld
  (`navigator.locks.query()`) when it starts is the first tab.
- Every tab reads views from IndexedDB and commits through §7.1.

### §7.9 Subscriptions

A bound replica subscribes the product scopes of the products its surface carries (the registry's
`surfaces`), and no scope of another product. It also subscribes the tree and overlay scopes its
product binding lists (A.1), and any `tree/<T>` while it is open: the engine exposes
`subscribe(scope)` and `unsubscribe(scope)`, which a product calls when it opens and closes a tree.
A subscribe deletes a `not-found` `KnownScope` record; the scope has no cursor, so its first pull
boots it. A `gone` record stays, since a scope's death is final (INV-13): a subscribe to it answers
`gone`, and nothing is pulled. An alive row of the governing type, arriving in any page or frame,
deletes a `not-found` record of its `tree/<id>` and `self/overlay/<id>` alike: the tree the record
denies exists, so the answer that wrote it is stale (a restore, then a create re-sent after it). The
scopes rejoin the subscription set, so the next puller run pulls them (§7.5). An `anon` replica
pulls only readable trees it opens. Every scope a replica pulls is held in full: a boot sends every
alive row (§6.7).

A tree or overlay scope whose governing record's create is still in the outbox, held, ready or
sent (by a delta or a prediction), stays in the subscription set but is neither pulled nor subscribed
(`sub`) on the live socket: the server holds no such scope yet. Both start once that entry has its
result. A `not-found` page or frame for such a scope is ignored and writes no `KnownScope`: the
server answered for a scope it does not hold yet. A `gone` needs no exception, since a tree that
exists only in the outbox cannot have died.

Reconciling the subscription set unsubscribes each scope that left it, and resolves the acked
entries of every scope outside it. It runs at the start of every puller run (§7.5); a push result
resolves no entry of a scope outside the set. The engine exposes `firstPullComplete(scope)`:
`CursorRec.booted` for a scope the replica pulls, and true for a scope it does not pull (an `anon`
replica pulls no product scope).

### §7.10 Replica lifecycle

**Sign-in as A** follows the lineage rule (D-27), per product. It runs after a hello served as A
(`as`, §9.1), which states the products in which A holds records (§9.2). An entry's product is its
scope's; a tree or overlay scope's product is its governing type's. It first releases every held
entry into the durable queue (Undo does not survive sign-in), before the decisions. While it is
incomplete, `DeviceMeta.pendingSignIn` holds A.
- Entries of lineage A, a `dormant(A)` replica's included, are sent without asking.
- Entries of the `anon` replica are added to A without asking for each product in which A holds no
  records.
- For each product in which A holds records and the `anon` replica has entries, a **signed-out
  decision** is due: an explicit add or discard of exactly those entries, of every type, with no
  default and no "later". The engine exposes `anonCount(product)` per decision: the count, by type,
  of the distinct records `(scope, type, id)` its entries create or change. A decision covers exactly
  the entries it counted: the engine pins their local ids, and when the product's entries differ at
  the answer (a commit, an undo or a result in between), the decision is due again with the new
  count. How the decisions are presented is product canon. Until every due decision is made the
  sign-in is not complete: the
  `anon` replica stays active, no replica changes and nothing is sent. Cancelling an incomplete
  sign-in changes nothing more; it resumes, with a new hello and every decision still due, at the
  next engine start.
- **Adoption boundary:** entries of another account's lineage are never adopted. A `dormant(B)`
  replica stays dormant.

Then, in one local transaction:
1. **Discard.** For each decision answered discard, the entries it covers end `discarded`, deletes
   released at the start among them, and the product's device rows in the `anon` replica are
   deleted.
2. **Bind.** A `dormant(A)` replica becomes `bound(A)`, with every cursor `null`. Otherwise the
   `anon` replica, when entries are left in it, is rebound (`state := bound`, `account := A`).
   Otherwise a new `bound(A)` replica is created.
3. **Add.** When `bound(A)` is not the rebound `anon` replica and entries are left in the `anon`
   replica, they move, with its device rows and notices, into `bound(A)`, preserving local ids,
   gesture ids and stamps, after `bound(A)`'s own entries in their commit order. The `anon` replica
   is then deleted. A moved device row whose key `bound(A)` already holds is dropped.
4. Every entry added to A, rebound or moved, takes lineage A, and `bound(A)` observes its stamps
   into `hlc` and `hlcHigh`. `authPaused := false`, and `pendingSignIn` is cleared.

**Other transitions:**
- **Sign-out of A** is a session that ends only by the person's finish or Cancel, even with nothing
  left to send:
  1. Every held entry is released into the durable queue (Undo does not survive sign-out), and the
     sender flushes the outbox for at most `SIGNOUT_FLUSH_MS`, then stops for this replica. A
     request still in flight is abandoned: results that arrive are recorded in the dormant replica,
     or dropped with a deleted one.
  2. The product's sign-out confirmation MUST state the count of ready and sent entries and offer
     Keep or Discard when any remain, and a plain confirm, which is Keep, when none do. The engine
     exposes `unsentCount(replica)` as the ready and the sent counts: a sent entry may already have
     landed. Keep covers every entry, counted or not. A Discard covers exactly the entries it
     counted: the engine pins their local ids, and when they differ at the answer (a result, a commit
     in another tab), it asks again with the new count.
  3. The finish, in one local transaction. Acked entries resolve: the server holds them. On Keep:
     delete A's confirmed rows, `SpentId` rows, cursors, `KnownScope` rows, staging and device rows,
     and set `state := dormant`; remaining entries are sent on the next sign-in as A. On Discard:
     delete the replica, and its entries end `discarded`. Discard removes them from this device; it
     cannot recall a sent entry the server may already have admitted.
  4. The `anon` replica, created if absent, becomes the active one, and A's credential is deleted.

  Cancel ends the session with A signed in: the sender resumes, and the released holds stay
  released. A sign-out is not durable: a process death before the finish leaves A signed in, as
  Cancel does, and nothing resumes it.
- **Credentials.** The engine keeps an account's credential only while the account is bound or its
  sign-in is pending (`pendingSignIn`). Engine start deletes every other stored credential, so a
  deletion a finished sign-out did not reach (a process death after its transaction) is retried
  there.
- **Discard unsent** (explicit, for `dormant`): delete the replica. Its entries end `discarded`.
- **Account change:** signing in as another account while A is `authPaused` is a sign-out of A,
  then a sign-in.

### §7.11 Fork guard and re-identify

At engine start (iOS and Android), a `DeviceMeta.forkGuard` that differs from its backup-excluded
copy, or a missing copy, triggers **re-identify** of every replica in the local database, and a new
`forkGuard`. A local database with no `forkGuard` (a first launch) mints its first guard, kept in
both places, without re-identifying. Re-identify, in one local transaction per replica:
1. Mint a new replica id. The re-identifying engine instance takes a new actor; other instances
   take one at their next launch (D-2).
2. `nextN := 1`, and `ackThrough := 0`.
3. Every `sent` entry returns to `ready`. The sender numbers them again in commit order, with new
   digests.

---

## §8 State machines

### §8.1 Intent

| From | Event | To |
|---|---|---|
| — | `commit` with hold / without hold | `held` / `ready` |
| — | `commit` over `PUSH_MAX_BYTES` / over a cap (§7.1 step 8) | not enqueued (a notice / none) |
| `held` | release (§7.3): `releaseAt` reached, leaving the app, engine start, sign-in or sign-out | `ready` |
| `held` | `undo` | `undone` |
| `held` | retired by a commit (§7.1 step 4): no command, and every delta removes a record the commit names | `undone` |
| `ready` | numbered | `sent` |
| `ready` | at numbering, its one-intent body over `PUSH_MAX_BYTES` (grown since commit, §7.4) | `refused` (`too-large`, a notice, or none for an orphan) |
| `held`, `ready` | emptied by the silent fold of an undo or a retire (§7.3) | `undone` (no notice) |
| `held`, `ready` | folded as a dependent (§7.7) | `refused` (in the dependency's notice) |
| `held`, `ready` | a write map merges its delete target into an existing record (§7.7) | `refused` (`target-merged`, a notice) |
| `sent` | `ok` | `acked` |
| `sent` | `clock-skew`, `base-unknown` | `ready` (recovered, same position) |
| `sent` | another refusal; a 400 or 413 on a one-intent request (§7.4) | `refused` (a notice, or none for an orphan) |
| `sent` | transport error, 401, 503, `retry`; a 400 or 413 on a several-intent request (halved, §7.4) | `sent` |
| `sent` | re-identify (fork guard, `replica-forked`, `replica-foreign`, `gap`, epoch change) | `ready` |
| `sent`, unprocessed | an earlier entry's `clock-skew` recovery (§7.7 step 1); a 400 or 413 on a one-intent request at a lower `n` (§7.4) | `ready` (restamped after a skew) |
| `acked` | `cleanSeq ≥ resultSeq` in the same epoch, checked by every page and frame and by the `ok` itself (§7.5); boot complete with `asOf ≥ resultSeq`; scope `gone` or `not-found`; the scope leaves the subscription set (§7.9); sign-out (§7.10) | `resolved` |
| `acked` | epoch change, when `resultEpoch ≠ epoch` | `ready` |
| any non-terminal | discarded by the person (§7.10) | `discarded` |

### §8.2 Replica

| From | Event | To |
|---|---|---|
| — | first launch | `anon` |
| — | sign-in as A, no `dormant(A)` and no rebound `anon` replica | `bound(A)` (new) |
| `dormant(A)` | sign-in as A | `bound(A)` |
| `dormant(B)` | sign-in as A | `dormant(B)` |
| `anon`, entries left after discards (§7.10) | sign-in as A, no `dormant(A)` | `bound(A)` (rebound) |
| `anon`, entries left after discards | sign-in as A with a `dormant(A)` | deleted (entries moved to `bound(A)`) |
| `anon`, no entries left | sign-in | `anon` |
| `anon` | sign-in as A with a decision still due, or cancelled | unchanged; nothing sent (§7.10) |
| `bound(A)` | sign-out, empty outbox or Keep | `dormant(A)` |
| `bound(A)` | sign-out, Discard | deleted |
| `bound(A)` | 401, `account-mismatch`, or an answer served as another principal (§9.1) / re-authentication as A | `authPaused` set / cleared |
| `dormant` | explicit discard | deleted |
| any | fork guard, `replica-forked`, `replica-foreign`, `gap`, epoch change | same state, new replica id |

### §8.3 Scope

| From | Event | To |
|---|---|---|
| `absent` | first write (product scope; overlay of a readable alive tree) | `alive` |
| `absent` | governing create | `alive` |
| `alive` | governing delete | `dead` (tree scope and every overlay of it) |
| `dead` | `SCOPE_HORIZON` elapsed | `dead`, rows removed |

Client cursor: none → boot (subscribe, `reset`, or a digest mismatch, §7.5) → live (last boot
page) → none (`gone` or `not-found`).

---

## §9 Wire protocol

### §9.1 Encodings

JSON over HTTPS and WebSocket. Every response carries `serverTime` and `epoch`, except a transport's
own `413` (below). Every request carries the registry version, on every surface: hello, push and
pull in the header `Sync-Schema`, and the live socket's upgrade request, to which a browser
`WebSocket` cannot add headers, in the query parameter `schema` (`/v1/sync/live?schema=<version>`).
The server reads each request's version from that carrier only, as its HTTP framework presents it. A
missing value, or one that is not a decimal integer, → `400 malformed`; a version below the server's
`minSchema` → `426 upgrade-required`. A change to the shape of any request or response raises the
registry `version`, and `minVersion` with it, so a client that speaks the older shape is answered
`426` at the version check, never `400` at the shape check. A browser cannot read the status of a
refused upgrade, so a web client learns a `426` from its hello, push or pull (§7.5). Keyed ids
declared as arrays (`edge: [from, to]`) have their `jcs` as identity.

**Credentials.** A request carries one credential or none. Any `Authorization` header or session
cookie, whatever its shape, is a credential sent. One that resolves makes the request its account's.
One that does not resolve (revoked, expired, unknown, or failing to parse) answers `401
unauthenticated` on hello, push, pull and the live upgrade alike: a request that sends a credential
is never served as anonymous. Only a request that carries none is anonymous: its push answers `401`,
its hello carries no `holdsRecords` (§9.2), its pull answers `not-found` for every `self/…` scope
(§6.7), and its live socket serves only the trees it can read (§6.8).

**Principal.** Every response from authentication (step 2 below) on carries `as`, the account it was
served as: the id its credential resolves to, or `null` for a request that carries none and for
every `401`. Every `change`, `gone` and `not-found` frame carries its socket's `as` (§9.5). A
`self/…` reference names the served principal's own scopes, so an answer served as anyone else
describes what that principal sees, not the replica's account. A replica of account A handles a
`200` or `409`, and a frame, whose `as` is not A (`null`, another account, or absent) as a `401`
(§9.6): `authPaused`, nothing applied and nothing forgotten. These are the answers whose handling
depends on the principal; a `400`, `413`, `426` or `503` is handled by its status alone.

An HTTP request is checked in this order, and the first failing check answers:
1. the registry version (above);
2. authentication: a credential that does not resolve → `401 unauthenticated`, on every endpoint,
   and a push without one → `401 unauthenticated`;
3. a push body over `PUSH_MAX_BYTES`, or a pull body over `PULL_MAX_BYTES`, measured as received,
   before it is parsed → `413 request-too-large`;
4. a body that is not JSON, or not of the endpoint's shape (§6.2 step 1, §9.4) → `400 malformed`;
5. more intents than `PUSH_MAX_INTENTS` → `413 request-too-large`; more scopes than
   `PULL_MAX_SCOPES` → `400 malformed`.

The HTTP transport MAY answer a body over its own limit, which is above every endpoint's bound, with a
bare `413` before these checks. A client never sends such a body.

**Numbers.** A number literal whose value is not a finite double (such as `1e400`), or a nonzero
literal that rounds to zero (such as `1e-400`), makes a body malformed. A client sends numbers as
`jcs` prints them, which never produces either.

**Integers.** Every integer on the wire is a JSON safe integer, at most 2^53 − 1 in magnitude: `n`,
`ackThrough`, `lastN`, `seq`, `rev`, `total`, `retryAfterMs`, a cursor's `s` and `a`, a `time`,
`instant` or `serial` value, and a number of a domain declared `integer`. Beyond it, a push's `n` or
`ackThrough` makes the body malformed (§6.2 step 1), a value in an intent is `invalid` (§6.1 step 2),
and a cursor is undecodable (§9.4).

An account id is a string of at most `ACCOUNT_ID_BYTES` bytes of UTF-8 holding no character `jcs`
escapes (a control character, `"` or `\`). The account service issues only such ids, and a
credential whose account id is any other does not resolve (`401`), so every account a push names
fits §7.1 step 8's widest body. Record ids and their key parts, account ids, scope keys and
references, replica ids, gesture ids, `requestId`s, and type, field and command names compare byte
for byte, in UTF-8. Every implementation MUST compare them so: no canonical equivalence, case
folding or other normalization.

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
                gestureId?: string }
```

A thin dead row is `{t, id, life, born?, seq}`.

### §9.2 Hello: `GET /v1/sync/hello`

```ts
→ { serverTime, epoch, as: string | null, schema: number, minSchema: number,
    holdsRecords?: Record<product, boolean> }   // authenticated callers; every product the registry declares
```

`holdsRecords` is present iff `as` is an account A; a hello whose credential does not resolve
answers `401` (§9.1). `holdsRecords[p]` is true
iff `acct:A/<p>` holds a row that `visible` (§7.6) accepts, of a `primary` type (§2.4): an existence
query over visible rows (§6.5). A row of a `visibleWhen` type counts only while one of its fields
holds a value, so an account whose rows are all empty holds none. A sign-in's lineage rule uses the
hello that precedes it (§7.10).

### §9.3 Push: `POST /v1/sync/push`

```ts
type PushRequest = { replica: string, account: string, ackThrough: number, intents: Intent[] }
                                                  // account: the replica's (§6.2 step 3)
type Result = { n, s: 'ok', seq: number, write?: {t, id: Id, from?: Id, born?: Stamp, f?: Record<string, Stamp>}[],
                detail?: Json }                                   // write: present, possibly [], iff a command
            | { n, s: 'refused', code: RefusalCode, detail?: Json }
type PushResponse = { serverTime, epoch, as: string, lastN: number, results: Result[],
                      retry?: {n: number, retryAfterMs: number} }
```

### §9.4 Pull: `POST /v1/sync/pull`

```ts
type PullRequest = { scopes: {scope: ScopeRef, cursor: string | null}[] }
type PullPage = { scope, kind: 'rows', rows: Row[], cursor: string, more: boolean, seq: number, digest: string,
                  total?: number, header?: {owner: {name: string}} }
              | { scope, kind: 'reset' | 'gone' | 'not-found' }
type PullResponse = { serverTime, epoch, as: string | null, pages: PullPage[] }
```

`seq` is the scope's seq and `digest` its scope digest, both in the page's snapshot (§6.7, §6.12).
A boot page carries `total` (§6.7 step 3). `more` is §6.7 step 4's.

A cursor is the unpadded base64url of `jcs({e, m, s, k?, a?})`:
- `e`: the epoch;
- `m`: `boot` or `live`;
- `s`: a seq, at least 0;
- `k`: the `[type, id]` of the last row sent, when a boot page or a page ending inside a seq
  continues after it. A cursor without `k` stands after every row of its seq;
- `a`: the boot's `asOf`, present iff `m = boot`, with `a ≥ s`.

Clients decode cursors (§7.5). Decoding is strict: a text that is not unpadded base64url of a cursor
of this shape, or that does not re-encode to itself, is undecodable, and the server answers `reset`
(§6.7 step 2).

### §9.5 Live: WebSocket `/v1/sync/live`

The upgrade request is `GET /v1/sync/live?schema=<version>`; §9.1 checks the version.

```ts
C→S: { op: 'sub' | 'unsub', scopes: ScopeRef[] } | { op: 'ping' }
S→C: { op: 'change', as, scope, epoch, seq, digest: string, rows?: Row[] }
   | { op: 'gone' | 'not-found', as, scope }
   | { op: 'pong' }
```

`as` is the principal the socket's upgrade was served as (§9.1), the same on every frame of the
socket.

Other `op` values carry ephemeral product messages, such as presence, and the engine ignores them.
Frames are at most `LIVE_FRAME_BYTES`.

### §9.6 Codes: the closed list

| HTTP | `error` | Client action |
|---|---|---|
| 400 | `malformed` | §7.4 |
| 401 | `unauthenticated` | pause (§7.4) |
| 409 | `replica-foreign`, `replica-forked`, `gap` | re-identify |
| 409 | `account-mismatch` | pause (§7.4) |
| 413 | `request-too-large` | §7.4 |
| 426 | `upgrade-required` | stop until upgraded |
| 503 | `unavailable` (`retryAfterMs`) | back off |

| Refusal code | Source |
|---|---|
| `not-found` | §6.1 step 3; commands (Appendix A) |
| `scope-dead` | §6.1 step 3; §7.1 step 2 (local) |
| `forbidden` | §6.1 step 3 |
| `invalid` | §6.1 step 2; §4; §6.4; product checks and commands |
| `too-large` | §6.1 step 9; §6.11; §7.1 step 8 (local) |
| `clock-skew` | §6.1 step 2 (recovered, §7.7) |
| `id-taken` | §4.3; commands |
| `id-spent` | §4.3 |
| `unknown-record` | §4.3; commands |
| `record-dead` | §4.3; commands |
| `parent-dead` | §6.1 step 10 |
| `stale` | §6.1 step 7; product checks and commands |
| `cap` | §6.1 step 12; §7.1 step 8 (local) |
| `base-unknown` | §6.11 (recovered, §7.7) |
| `request-conflict` | §6.3 |
| `request-running` | §6.3 (server origin; retry later) |
| `internal` | §6.6 |
| `target-merged` | §7.7 write map (local) |

The closed list of refusal codes is this table and the `codes` each product's registry declares
(§2.4), which Appendix A lists. A client that meets a code its registry does not declare (a product
code newer than its version) treats it as any refusal: its notice holds the code and the content, and
product copy shows its generic refusal line.

### §9.7 Limits

| Limit | Value |
|---|---|
| `MAX_RECORD_BYTES` | 1 048 576, a joined row (admits a 131 072-byte body at worst-case JSON escaping). It is measured before step 11's serial (§6.1 step 9), so a stored row may exceed it by that register. |
| `PUSH_MAX_INTENTS` / `PUSH_MAX_BYTES` | 64 / 2 097 152 (admits a text intent with its inline base) |
| `PUSH_WORK_MS` | 50 |
| `PULL_PAGE_BYTES` | 1 048 576 (at least one row) |
| `PULL_MAX_SCOPES` / `PULL_MAX_BYTES` | 64 / 65 536 (admits `PULL_MAX_SCOPES` scopes with their cursors) |
| `LIVE_FRAME_BYTES` / `LIVE_INLINE_BYTES` | 131 072 / 65 536 |
| `KEEPALIVE_BYTES` | 65 536 |
| `ACCOUNT_ID_BYTES` | 64, an account id's UTF-8 bytes (§9.1) |
| `MERGE_WORK_CELLS` | 4 194 304 (a `diff3` edit script; above it, one whole-text conflict, §6.11 step 2) |

---

## §10 Clocks

### §10.1 Encoding

D-1 gives the encoding. A parser reads `ms` and `counter` up to the first two colons; the remainder
is the actor.

### §10.2 HLC

```
physNow():  client = deviceWallMs() + serverOffsetMs
            server = max(wallMs(), the greatest value it has returned in this process)
tick():     p := physNow(); if p > ms: (ms, counter) := (p, 0)
            else counter += 1; if counter = 2^32: (ms, counter) := (ms + 1, 0)
            return (ms, counter, actor)
observe(s): if (s.ms, s.counter) > (ms, counter): (ms, counter) := (s.ms, s.counter)
```

Clients observe `hlcHigh` at engine start and in every commit, and every stamp of every row the
server sends. The server's `serverNow` (§6.1) is its `physNow()`, so it never steps back within a
process.

### §10.3 Server stamps

For a server delta, the server:
1. observes the stamp of every register it writes, as stored in the locked rows and as a client
   delta of the same intent writes it;
2. ticks once per pass of §6.1 step 9 that joins server deltas;
3. stamps those registers with the result.

It observes no other client stamp. A server delta and a client delta on one register in one intent
so join to the server's.

Server stamps need not be unique across scopes, and a refused intent need not advance the clock.
Every join, guard and restamp compares stamps of one register, and one scope's admissions are
serialized (§6.1 step 3), each observing the stored registers it writes.

### §10.4 Skew, offset and time fields

- **Skew bound.** Admission refuses a stamp beyond `serverNow + MAX_SKEW_MS`, and the server never
  restamps. A `time` value beyond the same bound is clamped to `serverNow` (§6.1 step 2).
- **Offset.** Each response yields `offset = serverTime − floor((tSend + tRecv) / 2)`, from the
  integer device wall ms at send and at receive, and `rtt`, the integer monotonic ms between them.
  `serverOffsetMs` is the offset of the lowest-RTT sample among the last `OFFSET_SAMPLES` (on equal
  RTTs, the latest), and it is persisted. A clock reading is wall ms, monotonic ms and a boot
  identifier. Two readings straddle a **jump** when their `boot` differs, or when the wall clock
  moved more than `CLOCK_JUMP_MS` away from the monotonic clock between them. A response whose send
  and receive readings straddle a jump yields no sample. Each sample stores its receive reading in
  `clockReading`. At the next sample, a reading that straddles a jump with the stored one discards
  the earlier samples; `serverOffsetMs` is kept until then.
- **Time fields.** A `time` field is a device-reported instant, stored as given after the bound.
  The server's own record times are `rc` and `ru`. How a product displays time is the product's
  rule.

---

## §11 Conformance

An implementation **implements the engine** iff it passes, in CI, every item below for its role:
server (C++), or client (JS, Swift, Kotlin).

### §11.1 Golden corpus: `packages/api-contract/sync/corpus/`

The corpus runs against the probe product (`packages/api-contract/sync/probe.registry.json`), and
its `README.md` states its conventions. `constants.json` holds the constants its vectors assume.

| Role | Files |
|---|---|
| all | `constants.json`, `stamp/{order,codec}`, `hlc/{tick,observe}`, `jcs/values`, `join/{lww,ranked,fww,life,born,record}`, `derive/slug`, `identity/seeded`, `digest/{row,scope}`, `protocol/*.jsonl` (hello, push, pull, live, join, skew and whole transcripts) |
| server | `identity/table` (every §4.3 cell), `admit/*`, `text/{tokens,script,diff3,merge}`, `push/serve`, `pull/{serve,hello}`, `live/death`, `machine/scope` |
| client | `hlc/{offset,jump}`, `fracindex/{between,drop}`, `view/{drawn,stored}`, `commit/*`, `hold/{release,undo}`, `refusal/{fold,restamp,base-unknown,transport}`, `write/map`, `lineage/{signin,signout,start}`, `pull/pages`, `machine/{intent,replica}` |

Runners assert exact equality, comparing values by `jcs`.

### §11.2 Property tests

Each property keeps its number wherever it is cited.
- **1.** The §3.3 laws for the lattice fields, `ranked` included, with equal stamps, equal ranks and
  absent registers.
- **3.** For intents that each change one record and carry no guard and no command, admitted by the
  reference server, the client's `drawn` view after each result and pull equals the server rows
  (INV-6).
- **4.** Admitting any permutation of a set of such intents, none of them refused, yields equal
  lattice fields.
- **5.** `between(a, b)` lies strictly between `a` and `b`.
- **6.** A scope digest maintained incrementally over any sequence of row inserts, replacements and
  deletions equals the digest recomputed from the resulting rows (§6.12).
- **7.** A text merge keeps text (INV-12), checked per token occurrence of the edit scripts, not by
  counts of equal tokens.
- **8.** Client: `clock-skew` recovery terminates (INV-14) under 409 and epoch returns, holds, undo,
  retire, keyed carriers, orphans and later gestures on the same records: with the server clock
  held still, every entry is acked or ends, and none is refused `clock-skew` twice.

### §11.3 Replay fuzz

A deterministic simulator drives the real engines against the reference server model on every CI
run, and against the real server and Postgres nightly.

**Faults:**
- drop, duplicate, delay and reorder;
- lost replies;
- process death between local transactions;
- clock error of ±10 min, and device clock jumps;
- holds, undo, retire, leaving the app, and activity or scene recreation;
- multiple tabs;
- sign-in under each lineage outcome (silent add; signed-out decision, add or discard), an
  incomplete sign-in, and sign-out;
- a credential that expires (`401`); one lost on the way, so a request is served as anonymous;
  and another account's, so a request is served as it and a push answers `account-mismatch`
  (§9.1, §6.2);
- poison;
- epoch change;
- a store restored from a snapshot, or cloned.

**It checks at every answer and frame** that one served as anyone but the replica's account changes
nothing the replica pulled (§9.1).

**It checks after quiescence:**
- INV-2: no resurrection without a revive or a newer keyed put.
- INV-3: every gesture visible, superseded, undone or in a notice.
- INV-4, INV-6 and INV-8.
- INV-7: no row of scope S reaches a principal without read access; existence answers are
  identical.
- INV-10.
- INV-15: every digest check matches.
- No bound replica holds a `not-found` record for a scope of an alive tree its account owns (§7.9).
- Every outbox is empty.

---

## Appendix A: Product bindings

Registry entries. "g" marks `idSpace: global`. `chars` and `bytes` are units (D-9): a length such
as ≤200 chars is a bound in that unit, the field's, or its domain's when nested (§2.4). A count,
`maxItems n of`, is an array domain's `maxItems`, never a length.

### A.1 Roadmap

**Surfaces:** web. **Primary types** (§9.2): `tree`.

| Type | Scope | Identity | Life | Fields | Cap |
|---|---|---|---|---|---|
| `tree` | self/roadmap | minted g `^t_[0-9a-f]{16}$`, governs `tree:<id>` | terminal, keep | — | — |
| `track` | self/roadmap | keyed (tree id) | yes, keep | — | — |
| `meta` | tree/T | singleton | — | `title` lww ≤200 chars; `visibility` lww **server** ∈ {private, unlisted, public}, `opens` at {unlisted, public} (D-4); `visibilitySetBy` lww server; `forkedFrom` const server | — |
| `node` | tree/T | derived ≤128 chars, fallback `step` | revivable, keep | lww: `label` ≤200 chars, `icon` ≤64 chars, `color`, `ord` (D-25), `pos` ({x, y} or null), `status`, `description` ≤16 000 chars, `links` (`maxItems` 32 of {url ≤2048 chars, label ≤200 chars}) | 10 000 |
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
    forkedFrom: src}`; copy every node, edge and kind row of `src`, with ids and stamps kept, `born`
    as §6.1 step 14 gives it, and `status` cleared. `src` is read under `FOR SHARE` on
    `sync_scopes(tree:src)`, taken after `acct:A/roadmap`.
  - Predicts `tree` and `track`.

**Other bindings:**
- **Projections:**
  - `tree_ops`: one headline per `(tree, gestureId)`, skipping position-only gestures;
  - the tree room: a read cache keyed by `(tree, seq)`.
- **Server-origin writers:** MCP roadmap write tools, each advertising an optional `requestId`
  (§6.3), and tending.
- **Consequences:** a `tree` delete also writes the owner's `track` of that tree dead.
- **Subscriptions** (§7.9): a bound replica also subscribes `tree/<T>` and `self/overlay/<T>` for
  every alive `tree` and `track` record.

### A.2 Gym

**Scope:** `self/gym`. **Device scope** `device/gym`, keyed per session
([gym Coach](mobile/gym_coach.md) §9.3): `movementOrder:<session>` (the live movement order, exercise ids), `movement:<session>` (the
chosen movement), `offer:<session>` (a pre-minted offer id), `rack:<session>` (rack state), and
`picture:<id>`, marked `localOnly`. **Surfaces:** web, iOS, Android.

Every minted type mints 16 base-62 characters and is seeded (D-8): a seed of at most 58 characters,
and `n ≤ 99 999`. Minted ids match `^[A-Za-z0-9_-]{8,64}$`, except `exercise` ids, which match
`^[A-Za-z0-9_-]{1,64}$`: seed exercise slugs such as `dip` are shorter. Seed exercise ids are
`foreign` to every account. **Primary types** (§9.2): `routine`, `session`, `set`, `note`,
`weighin`, `exercise`.

| Type | Identity | Life | Fields | Rules |
|---|---|---|---|---|
| `routine` | minted g | terminal, spent | lww: `name` ≤240 bytes, `ord` (D-25), `entries` (`maxItems` 50 of {`exerciseId` (the only required key), `restSeconds` 15–900 or null, `sets` (`maxItems` 20 of {`reps` 1–100 or null, `weightKg` ±500 or null, quantum 0.01})}) | Editor save guards the fields it writes. Changing `name` or `entries` supersedes its pending proposals. Delete kills its proposals and writes `routineId = null` on its sessions. Projections: `revision`; `position` = dense rank of `(ord, id)` among alive routines. |
| `exercise` | minted g | terminal, spent | `name` lww ≤240 bytes; const: `pattern` ∈ {squat, hinge, press, pull, carry, core, isolation}, `equipment` ∈ {barbell, dumbbell, machine, cable, bodyweight, kettlebell} | Never deleted (a delete is `invalid`). |
| `exerciseName` | keyed (`ref<exercise>`) | yes, spent | `name` lww ≤240 bytes; `aliases` lww server (`maxItems` 5 of ≤240 bytes) | A rename appends the old name to `aliases`. |
| `session` | minted g | terminal, spent | `routineId` lww server `ref<routine>` or null; `plan` const server, JSON or null; `startedAt` time; `finishedAt` lww server, an epoch ms, never null; `closedBy` lww server ∈ {finish, stale}, never null; `displayName` lww server ≤240 bytes or null | Created only by commands. At most one session with `finishedAt` unset per account. A delete runs `gym.closeStale` inside its admission, then refuses a session whose `finishedAt` is still unset with `session-open`. Delete kills its sets. |
| `set` | minted g | terminal, spent | `sessionId` const `ref<session>` parent; `exerciseId` const `ref<exercise>`; `setNumber` serial, next `[sessionId, exerciseId]`; lww: `weightKg` ±500 quantum 0.01, `reps` 1–500, `kind` ∈ {warmup, working, drop, failure}, `rpe` 1–10 or null quantum 0.1, `note` ≤4000 bytes, never null; `completedAt` time | Set rules below. |
| `note` | minted g | terminal, spent | lww: `title` 1–60 chars, `body` ≤500 bytes, `ord` (D-25) | Cap 10. Editor save guards the fields it writes. Projection: `position` = dense rank of `(ord, id)` among alive notes. |
| `weighin` | keyed (local date `YYYY-MM-DD`) | yes, spent; `wholePut` | lww: `kg` 20–400 quantum 0.01, `recordedAt` an epoch ms, which each save writes from the read-and-commit function's `now` | `origins: [replica]`. `check` refuses a write of a day later than the day after `serverNow`'s UTC date with `bad-instant`. A weigh-in is one fact (§2.4): each save writes `kg`, `recordedAt` and presence at one stamp, so the newest save wins whole, whatever `recordedAt` holds, and a save newer than a delete, held or not, keeps the weigh-in. |
| `prefs` | singleton | — | lww, with registry `default`s (§2.4): `units` ∈ {kg, lb} (kg), `restSeconds` 15–900 or null (null), `restSound` (true), `confirmHaptic` (true), `confirmSound` (false) | Phones edit `units`, `confirmHaptic`, `confirmSound`. |
| `proposal` | minted g | terminal, spent | const: `routineId` `ref<routine>`, not a parent; `intent` ∈ {revise, remove}; `proposedName` ≤240 bytes; `summary` ≤400 bytes; `changes` (`maxItems` 100); `door` ∈ {ask, mcp}; `connection` ≤128 bytes; `threadId` lww `ref<thread>` or null; `state` ranked server (pending 0; applied, dismissed, superseded 1); `supersededBy` lww server ∈ {proposal, routine} | Rules: [gym Coach](mobile/gym_coach.md) §9.2, §11. A replica's create requires `door = ask` and an empty `connection`, and carries a guard (D-19) on every routine register its content is based on, `entries` and `name`, at the stamps it read; a moved stamp → `stale`. `check` re-checks the create by them (`invalid`) and writes `state = pending`. The supersede of the pending proposal of the same `(routine, door, connection)` is written before the new proposal is inserted; at most one is pending per `(routine, door, connection)`. Projections: `baseRevision` and `baseName`, the routine's `revision` and `name` at admission; a replica never supplies them. |
| `thread` | minted g | terminal, spent | `title` const ≤8000 bytes | Fields and rules: gym Coach §9.1. Delete kills its messages and writes `threadId = null` on its proposals. |
| `message` | minted g | terminal, spent | `threadId` const `ref<thread>` parent; const: `role` ∈ {lifter, coach}, `replica` (`rp_` and 32 lowercase hex, or `srv`), `pictures` (`maxItems` 1 of {`id`, `mediaType` `image/…`, `localOnly`?}); lww: `text` ≤131 072 bytes, `truncated`, `receipt` ≤16 384 bytes, `calls` ≤32 768 bytes; `state` ranked (running 0; interrupted 1; completed, declined, failed, stopped 2); `at` time | Fields and rules: gym Coach §9.1 and §4.5, which `check` enforces (`invalid`). |

**Set rules** (`check`):
- An open session admits every set.
- A session closed by `finish` → `session-finished`.
- A session closed as `stale` admits a set iff `completedAt ≤ finishedAt + 4 h`, and then sets
  `finishedAt := max(finishedAt, completedAt)`. Otherwise → `session-finished`.
- Every exercise reference (a set's `exerciseId`, a routine entry's `exerciseId`, a command's set)
  must be a seed or the owner's; otherwise `unknown-exercise`.

**Commands.** `gym.closeStale` (`beforePull`, §2.4) runs first inside `gym.start`,
`gym.importSession`, `gym.correctSession` and a session delete's admission, before every pull of an
existing `self/gym`, and before every server read of session state (REST and MCP). It is the only
writer of `closedBy = stale`.

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
  Creates a finished session (`closedBy = finish`) and its sets, with no join. `sets` holds at most
  200 sets, each `{id, exerciseId, weightKg, reps, kind?, rpe?, note?, completedAt}`, with a set's
  bounds and quanta. A set's `completedAt` is an integer epoch ms inside a `json` argument, not an
  `instant`, so §6.1 step 2 does not bound it: the command's check does (`bad-instant`).
  - Own `id`: alive with equal raw arguments (its receipt) → ok; with different arguments →
    `payload-conflict`. Dead → ok.
  - `foreign` → `id-taken`.
  - `finishedAt < startedAt`, `finishedAt > serverNow`, or a set outside `[startedAt, finishedAt]`
    → `bad-instant`.
  - The interval crosses another finished session → `session-overlap`.
  - A routine the owner cannot read → `plan = null` and `routineId = null`.

  Sets are numbered in argument order. Predicts the session and its sets.
- **`gym.correctSession {sessionId: ref<session>, requestId, startedAt: instant, finishedAt: instant, routineName, sets}`.**
  Each set is `{id, exerciseId, setNumber, weightKg, reps, rpe?, note?, completedAt}`, with a set's
  bounds and quanta, its `completedAt` bounded by the command's check as `gym.importSession`'s is. `requestId` matches the gym id pattern, and `routineName` is ≤240 bytes or
  null. It replaces a finished workout:
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

**Codes** (§9.6), the registry's `codes`: `payload-conflict` (`gym.importSession`,
`gym.correctSession`), `session-finished` (the set rules), `session-open` (`gym.start`; a delete of
an open session), `session-overlap` (`gym.importSession`, `gym.correctSession`), `unknown-exercise`
(the set rules), `bad-instant` (the commands; a weigh-in's future day).

### A.3 Journal

**Scope:** `self/journal`. **Surfaces:** web, iOS. **Primary types** (§9.2): `page`.

| Type | Identity | Life | Fields |
|---|---|---|---|
| `page` | keyed (local date `YYYY-MM-DD`) | none; `visibleWhen: [body, mood, energy]` | `body` text ≤131 072 bytes; lww: `mood` an integer 0–10 or null, `energy` an integer 0–10 or null, `source` ∈ {typed, spoken} |

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
| `SIGNOUT_FLUSH_MS` | 5000 |
| `MAX_SKEW_MS` | 300 000 |
| `K_POISON` | 3 |
| `LOCK_TIMEOUT_MS` | 2000 |
| `PULL_FALLBACK_MS` | 300 000 |
| Backoff | base 1000 ms; ceiling 300 000 ms, or 30 000 ms while `liveHint`; full jitter |
| Live reopen backoff | base 1000 ms; ceiling 30 000 ms; full jitter; `k` resets after 30 000 ms open |
| `OFFSET_SAMPLES` | 8 |
| `CLOCK_JUMP_MS` | 1000 |
| `SCOPE_HORIZON` / `REPLICA_GC` / `REQUEST_RETENTION` | 30 / 365 / 90 days |
| `REQUEST_LEASE_MS` | 60 000 |
| Gym stale window | 4 h |
