# Windmill sync engine

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, steps, definitions
(`D-n`) and invariants (`INV-n`) are numbered so reviews and code can cite them.

## §0 Status and scope

**Status:** The C++ server (`backend/platform/**/sync*`) carries the engine, with clients in JS
(`web/src/platform/sync`), Swift (`apps/ios/Sync`) and Kotlin (`apps/android/sync-*`);
`packages/api-contract/sync/reference/` is its JS reference. `windmill_server` serves the gym and
journal composition on `/v1/sync`, and the engine is the only writer of their records: web (gym,
journal), iOS (journal, gym) and Android (gym) write through replicas, and MCP, the Coach and gym's
import door admit as the server (A.2). Production's gym and journal rows were adopted in place
(Appendices C and D). `windmill_server_probe` carries the test-only contract.

**R118 contract:** The composed registry has version 5 and minimum version 4, so installed v4
journal clients remain supported. A.2 specifies gym's metadata, and C.8 how the adopted rows took
it. `composition.json` composes gym and journal, whose versions rise together (§2.4); journal's
field shape is unchanged. Every other product starts from empty stores.

**Retired REST writes:** gym's former REST write paths answer `410`
`{"error":"This version of the app can no longer save; update it.","code":"client-update-required"}`
before authentication, parsing or data access, and [gym ARCHITECTURE](../../backend/products/gym/ARCHITECTURE.md)
lists them. Journal has no REST page writer. Reads, shares, exports, the Coach, the import door,
echoes and nudges stay REST. `/v1/sync` has its own `426 upgrade-required` minimum-schema refusal
(§9.1).

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
- Gym's Coach conversations, until the phone Coach binds them (A.2).
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
lowercase hex characters. One device database holds any number of replicas, one of them *active*
(§7.12).

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
| `text` | a string merged by the server, or replaced by a command (§6.11); clients never join it |

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
- `undone`: Undo or retire while held, an anonymous gesture superseded before binding (§7.1
  step 4), and every dependent entry that their silent fold empties (§7.3);
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
- A foreign key between synced tables has no `ON DELETE` action, but for a table holding one
  record's register, whose rows go with that record's row. Nor does a synced table's foreign key to
  any other table, but for its account's row: account deletion purges every scope the account owns
  (§2.3 `purge`). Every referential consequence of a delete is a write by admission, in the same seq
  (Appendix A lists them). `apply` writes the consequences before it removes the parent's typed row,
  children first.
- A table adopted in place (Appendices C and D) MAY take its scope from an existing column in place of
  `scope_key`, with the index `(<that column>, seq)`.

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
  virtual std::set<Id> elsewhere(Txn&, const ScopeKey&, std::span<const Id>) = 0;    // global ids held outside this scope (§4.2)
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
(`packages/api-contract/sync/<product>.registry.json`). A deployment composes the registries
`packages/api-contract/sync/composition.json` names into one: they declare one `version` and one
`minVersion`, and no product, type or command name twice. The deployment binds every type and
command they declare, so it never admits a type it cannot store, and its clients compose exactly
those registries: server and client speak one registry, named by its version. A product joins the
composition, and a type its product's registry, in the change that binds it on the server, and the
composition's `version` rises with it (§9.1). `minVersion` MUST rise above every incompatible
version when the envelope shape changes, a declared product or type is dropped, or a rule enforced
by clients changes. Additive products, types and fields do not raise `minVersion`: clients retain
and hash unknown fields and types harmlessly (§7.6). R118 is additive, so v5 accepts v4 clients;
the installed journal client reads no gym records and is never refused `426` for this upgrade.

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
                   behind?: true, mismatchReset?: true, digestStop?: string }
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

- `replica`, in every record above but `ReplicaMeta`, names the replica by the store's handle, which
  a re-identify leaves alone; its id is `ReplicaMeta.replica`, and nowhere else (§7.11).
- `hlcHigh`: the greatest stamp this replica minted or observed.
- `admittedHigh`: the greatest stamp in any row the server sent (pull, live) or in an acked entry.
- `CursorRec.digest`: the scope digest (§6.12) of the replica's confirmed rows of the scope. A boot
  into staging keeps its own digest until the swap (§7.5).
- `CursorRec.booted`: the scope's first pull is complete, a boot having finished with the cursor
  live (§7.5). It is deleted with the scope's cursor.
- `CursorRec.behind`: the scope's rows may not be the server's at the cursor's seq: the last page
  applied to the scope ended short of its head (`more`), or a chunk of a page committed and the
  page's last did not (§7.5 step 2). No `change` frame applies inline while it is set (§7.5 step 3).
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

**The writer.** The store runs one writing transaction at a time. A commit (§7.1) waits for the
writer, and the person waits for the commit, so the engine's other transactions are short. This is a
latency intent, not a conformance item (§11):
- Each of them SHOULD hold the writer at most `WRITER_SLICE_MS` as the M11 benches measure it, on an
  M3 Pro Mac and the iOS 26.3 simulator (the oldest supported iPhone is estimated 3–4× slower), and
  a commit waiting for the writer SHOULD take it before the engine's next transaction.
- Three steps may take several transactions for this: a pull page applies in chunks, the entries its
  cursor covers settle in slices (§7.5 step 2), and a push answer's results apply in batches (§7.4).
  Every other step stays one transaction, an epoch change (§7.5 step 1), a staging swap and the
  transactions of §7.10 and §7.11 among them. The rule bounds a transaction's time, not its rows: how
  many rows a chunk takes, or entries a slice or batch, is the implementation's.
- Rows that a transaction takes out of every view MAY be deleted from storage afterwards, in
  transactions of their own:
  a dropped staging, the confirmed rows a staging swap replaces, a forgotten scope's rows (§7.5 step 2,
  §7.9) and a signed-out replica's (§7.10). From the transaction that takes them out, no view, digest,
  count or rule reads them. So no single transaction's work grows with the rows it takes out; a staging
  swap SHOULD NOT grow with the rows it brings in either (it can switch which stored rows are the
  scope's confirmed rows).

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
- `foreign`: `idSpace: global` and the id exists or is spent in another scope, or the product holds
  it outside every scope (gym's seed exercises, A.2); or, for a governing type, the governed scope
  exists and is not governed by this `(scope, type, id)`.
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
  register only with its source, or lowers it when no unacked entry is its source (§7.7 step 1.5),
  which never lets it out-stamp a delete. A put of a `wholePut` type asserts presence at its own
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
- After a restore, acked entries return to `ready` (§7.5): a replica with an acked entry holds an
  epoch (§7.4), so the restore's epoch changes it.
- An acked entry resolves once its scope's stored cursor covers it. A death between settling slices
  leaves it covered, and the scope's next stored cursor settles it (§7.5 step 2).
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
removes it before release, no anonymous replacement supersedes it before binding (§7.1 step 4),
the person does not discard it (§7.10), and it is not folded with a
record it depends on (§7.3, §7.7).
Process death and in-app navigation, including an activity or scene recreation, never abandon it.
The early releases, which end Undo, are leaving the app, sign-in and sign-out (§7.3, §7.10). After
process death, the next engine start releases it.

*Proof.*
- Held entries are durable rows. They leave `held` only by `release`, `undo`, a retire, a supersede, a discard
  or a fold (§7.1 step 4, §7.3, §7.7, §7.10).
- `undo` succeeds, and a retire acts, only while every entry of the gesture is held. A retire acts
  in the retiring commit's own transaction, on command-free gestures that only remove records the
  commit names (§7.1 step 4).
- Supersede is confined to complete unnumbered anonymous gestures. An anonymous replica has
  never been bound or sent a product intent, and binding ends its eligibility; no transport
  rewind can make sent work eligible. The replacement and removal commit together.
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
  induction from empty stores (§10.3), or from an adopted scope, whose every envelope stamp is
  its adoption's `M:0:srv` (Appendices C.7 and D.7). A product value representing a content clock is
  not an envelope stamp and is never observed into the engine clock.
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
    admitted stamp. A predicted register the map gives no stamp belongs to no unacked entry once its
    command has its result: a stamp it leaves above `admittedHigh` in a later entry is unsourced,
    and that entry's recovery lowers it to the recovered clock's reading, which passes (§7.7
    step 1.5).
  - No source leaves the outbox unadmitted with a dependent behind it. An undo, retire and supersede fold
    their dependents silently (§7.3), none of which is numbered while its source is held (§7.4).
    A refusal folds the queued dependents and orphans the sent ones. An orphan's whole content is a
    source whose dependents are held back until its result: its `ok` admits their source, and its
    refusal, which recovers nothing, folds them (§7.4, §7.7). A discard ends every entry of its
    product (§7.10).
  - So a recovered entry's resend passes the check.

**INV-15 Verified replica.** When a page or frame leaves a scope's cursor live at the page's or
frame's seq N, without a key, the replica holds exactly the server's alive rows (§6.12) of the scope
at N, or the digest check of that transaction detects that it does not (§7.5 step 4). A scope whose
checks stopped runs none until the app version changes.

*Proof.*
- The server's scope digest at every committed seq is the sum over the scope's alive rows at that
  seq. It starts at 0, or, in an adopted scope, at the sum over the rows it adopted
  (Appendices C.7 and D.7), and the transaction that changes a row changes it (§6.12).
- A pull page reads its rows and its `(seq, digest)` in one snapshot (§6.7), and a live frame
  carries the digest committed with its seq, so a received `(N, d)` is the server's state at N.
- The client changes its digest in every transaction that changes its confirmed rows, each chunk of
  a page included (§7.5 step 2), hashing each row as received, so its digest is the sum over the rows
  it holds.
- Such a page or frame triggers a check in its own transaction (§7.5 step 4), so every pull that
  reaches the head checks. Equal row sets give equal sums. Unequal sets give equal sums only if the
  hashes of their difference sum to 0 mod 2^256, with probability about 2^−256 for a difference not
  chosen to collide. The digest is a correctness check, not a security boundary: a replica checks its
  own cache against rows it may read.
- A detected mismatch resets the scope, and by INV-5 the boot delivers every alive row at its
  `asOf`. A mismatch right after such a reset is reported and not reset again (§7.5).

**INV-16 Bounded following.** While the app is in the foreground and its live socket is open, every
scope of the subscription set is followed, waits for its governing record's create, or is in doubt
with a re-pull scheduled or in flight, a request being in flight for at most `REQUEST_TIMEOUT_MS`
(§7.9). Whatever the server answers, a scope in doubt is
re-pulled at most once per backoff draw, and subscribed again only after a rows page of it is applied.

*Proof.*
- **No quiet scope.** A scope stops being followed only by an `unsub` (it left the set), by the
  socket's close, or by a frame's end. An end the client applies records the scope known, which takes
  it out of the set (§7.5 step 2). An end it ignores puts the scope in doubt, and the doubt's start
  schedules a re-pull. A re-pull that ends with the scope still in doubt schedules the next, whether it
  was answered by another ignored end or not answered: a request lasts at most `REQUEST_TIMEOUT_MS`,
  after which it is a transport error. A rows page ends the doubt, and a scope of the set that is
  neither in doubt nor followed is subscribed at once. A scope waiting for its governing create starts
  on the create's result (§7.9).
- **No fast `sub`.** `sub` goes only to a scope of the set not in doubt. A frame's end leaves the
  scope known, out of the set until a subscribe or an alive governing row clears the record (§7.9), or
  in doubt, which only an applied rows page ends. So between two ends of a scope's following stands a
  person's subscribe, a governing row the server committed, or a pull of the scope that brought rows.
- **No fast pull.** Re-pulls come one at a time, each `random(0, min(30 s, 1 s · 2^k))` after its
  cause, `k` rising by one each; `k` returns to 0 only after the scope stayed followed, not in
  doubt, for 30 s in one stretch, when it leaves the set, or at a sign-in, a sign-out or a
  re-identify of the active replica. Every other pull has a cause the server's answers
  do not drive: a person's act (foreground, a subscribe), a launch, a socket reopen, which backs off
  on its own (§7.5), the fallback interval, a change the server committed (a live gap), a
  re-authentication, or a sign-in, a sign-out or a re-identify. A stale page and a page short of its
  head (`more`) pull again only after a cursor moved, and a scope has one pull in flight at a time
  (§7.5).
- So a loop of answers — a `sub` or a pull answered `not-found` while the client holds the governing
  record alive — turns at most once per re-pull draw, whose bound doubles to 30 s, never at the
  socket's round-trip speed. It lasts while the contradiction does: a rows page ends it, and so does
  the client's ceasing to hold the governing record alive, after which the end is applied.

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
   - Text fields are merged or replaced by a command's internal replacement (§6.11).
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
  scope lock, from rows or from a cache whose seq equals `scope.seq`. A builder that finds nothing
  to write admits nothing, and its call answers from what it read.
- **Server-built bulk writes** classify each incoming id as create, update or spent before building
  deltas, and report spent ids to the caller.

### §6.4 Commands

`handler(txn, ctx, args) → {deltas, write, detail} | refuse(code)`:
- It is deterministic given the locked rows, `args` and `serverNow`.
- It MAY lock more rows through the ports, and MAY write any field.
- It resolves its own replays (Appendix A), comparing the raw arguments, or their digest, stored with
  its receipt, before the guards are checked (§6.1 step 7).
- A command not in the registry is refused `invalid`.
- A command MAY replace a text head: its internal text write is `{text, replace: true,
  archiveNonempty: boolean, archive: metadata}`. This is a handler output, never an intent's wire
  delta; a wire text write has only `text` and `base`, and any other member is refused `invalid`.
  Replacement passes the field and
  record bounds, writes `merged = false` and a new head rev at the admitting seq, and keeps the
  previous head when that head has a rev, except an empty head when `archiveNonempty` is true.
  `archive` holds the binding's revision metadata, which cannot replace its type, id, field, rev or
  text. A replacement MUST accompany a
  changed register or changed text, so it cannot mint a rev without a changed row. A binding MAY
  retain revision metadata and prune revisions in the admitting transaction, as Appendix A states.

### §6.5 Caps

`sync_scopes.counters[type]` equals the number of alive records of the type in the scope, and is
kept for capped types only. A new scope's counters are 0, an absent key reading 0; an adopted gym
scope's started at C.6's counts. Only step 13 changes them. The cap check reads the counter and never counts rows.
`holdsRecords` (§9.2) needs no counter: it is an existence query over visible rows of primary types.

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
- The server answers every `ping` with `pong` at once, and keeps an idle socket open at least
  `LIVE_PING_MS + LIVE_PONG_MS`; a deployment's edge keeps the same bound.
- A `sub` to a scope its principal cannot read is answered at once with the `gone` or `not-found`
  a pull would give, and is not kept.
- A visibility change that removes a subscriber's access sends `not-found` and ends that
  subscription.
- The per-socket access check MUST use in-memory state, invalidated by every write to an `opens`
  field, by scope death, and by the revocation of the socket's credential. A socket whose credential
  is revoked or expires is closed before it sends another frame or answers another `sub`: it never
  goes on as anonymous. Every deletion of a session (sign-out, revocation, account deletion, an
  expiry sweep) goes through the one revocation path that closes its sockets, so the bound is that
  close: no frame follows a deletion. A deletion that bypasses the path is a defect, never a delay
  the engine allows for.
- A deployment with several server processes MUST relay committed changes to every process holding
  subscribers.

### §6.9 Projections and read caches

`apply` MAY write derived rows, and derived columns beside a typed row's registers, in the admitting
transaction; neither is part of a row `feed` returns (§6.12). Appendix A lists them. A read cache
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

A command's internal replacement (§6.4) bypasses base resolution and diff3. It stores the exact
replacement text with `merged = false` and a head rev equal to the admitting seq; its binding
decides whether to archive the outgoing head, including when the text is equal. Step 3's text bound
and §6.1 step 9's record bound still apply. All other text writes follow the algorithm below.

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
commands included), and a command's writes into a scope it creates (§6.1 step 14). An adopted
scope's digest started from the sum its adoption stored, which C.8's supplement moved in the
transactions that wrote it (Appendices C.6, C.8 and D.6). Every referential consequence (§2.2) is a change of step 13, and a derived row that `apply` writes (§6.9) is never a
`feed` row. A governing create starts its scope at digest 0. Scope death changes no row, and a dead
scope's digest is never sent; G5 sets it to 0. A restore brings it back with its rows. A pull reads
the stored digest and never sums rows.

**Client.** The client keeps the same sum over its confirmed rows, hashing each row as received,
and checks it against the server's (§7.5). It MAY store each row's hash beside the row. Pending
entries and predictions never enter it.

---

## §7 Client algorithms

### §7.1 `commit(scope, changes, opts) → {localIds, retired, superseded?, stamp} | Refused | none`

`opts = {atomic, hold, guard, retire, supersede, cmd, predict, local, gestureId}`. `commit` is a synchronous
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
and before step 2, with `drawn` and `stored` read inside the same transaction, the commit's
`physNow()` reading (step 4) and the id of the replica the commit writes to, the active one (§7.12),
so a read and the writes it decides are one transaction. The function
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
4. **Supersede, retire, then deltas.** `supersede` lists distinct gesture ids whose complete effects the
   new gesture replaces. It is allowed only in an anonymous replica, whose entries have never
   been sent (§7.10). Each named gesture MUST exist in this replica and scope, and all of its
   entries MUST be held or ready with `n` absent; otherwise throw before changing anything.
   Remove those whole gestures and fold their dependents silently (§7.3), as for an undo.
   Return their ids as `superseded`, in commit order, when any were named. The replacement MUST
   carry every effect the product keeps, including monotone state writes: superseding does not
   copy old deltas into the replacement. A refusal or failure of this commit supersedes nothing.
   Then the retire: `retire` lists records `(t, id)`, and every held
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
     type, changed or not, stamped `s`; a change that leaves one out throws. A change that removes a
     `wholePut` record carries its life alone (§6.1 step 2 refuses a dead whole delta with a field
     register); one that names a field value throws.
   - A text edit of a field that is not a text field of the record's type throws. A `wholePut` type
     has none (§2.4), so any text edit of one throws.
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
   - A command prediction MAY include server-written lattice fields and text. Predicted text
     folds locally as the proposed text, and is never sent as a delta or entered in the digest.
     The command's confirmed row supplies its actual text and rev, through the result and pull.
5. **Ids.** Minted ids come from a CSPRNG by the type's `mint`, or are seeded (D-8). Label-based
   derived ids come from `derive` (D-26).
6. **Guards.** `guard` lists registers `(t, id, field)`, and guards exactly those: each becomes
   `(t, id, field, its stamp in stored)`, null when unset (D-19). Each listed field MUST be a
   lattice field of a type the commit's scope holds; any other throws: `life`, a text field, an
   undeclared field, or a field of a type another scope holds. A text field is never guarded: it
   has no stamp; direct text edits merge instead (§6.11), and a command resolves its own condition.
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
restamp or a write map (§7.7), or ends before binding by a supersede (§7.1 step 4).

### §7.3 Hold, release, undo

```
release(entry): tx: if entry.state = held → state := ready; kick the sender
undo(gestureId): tx: if every entry of the gesture is held → delete them, fold their dependents
                 silently (below), return true; else return false
```

**Silent fold.** An undo, retire and supersede (§7.1 step 4) fold the dependents (§7.7 step 3) of the entries
they end silently, in the same local transaction, with no notice: in every later held or ready entry,
the dependent deltas are removed, with the guards on their records, and a dependent command with its
prediction. An entry left empty ends `undone`. A dependent of a held entry is never numbered (§7.4),
so a silent fold never meets a sent entry. A supersede's source and its dependents are anonymous,
and likewise have never been sent.

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
  network error, or no answer by REQUEST_TIMEOUT_MS → backoff
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
  in the first batch, before its first result: if serverEpoch is null → serverEpoch := the response
      epoch (an answer with no result takes it in the transaction that sets ackThrough)
  each result, in ascending n, in batches (below):
    ok      → acked, resultSeq := seq, resultEpoch := the response epoch; apply the write map (§7.7)
    refused → §7.7; after a `clock-skew` recovery, back off before the next push
  in the last batch, once every result is recorded: ackThrough := the response's lastN
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

**Result batches.** A batch is one local transaction holding one result or several, the next in `n`
order, sized by §2.5's writer rule; a commit may take the writer between two batches. A reader
between batches sees every result up to some `n` recorded and none after it. A process death between
batches keeps the batches recorded and loses the rest: their entries stay `sent`, `ackThrough` has
not moved, and the next push resends them. The server answers them from its stored results (§6.2
step 4), or `replica-forked` for an entry an earlier batch's `clock-skew` recovery rewrote, which
re-identifies with nothing lost (§7.7).

A null `serverEpoch` takes the answer's epoch in the first batch, so no entry is ever acked while
`serverEpoch` is null. Were it taken later, a death before the take would leave entries acked in an
epoch the replica never held. A null `serverEpoch` takes any answer's epoch silently, with no epoch
change (§7.5 step 1), so after a restore those entries would neither resolve (their `resultEpoch` is
not `serverEpoch`) nor return to `ready`.

### §7.5 Puller, reset and epoch change

The puller runs on start, foreground, reconnect, a live gap, a subscribe (§7.9), a re-pull of a
scope in doubt (§7.9), a re-authentication that clears `authPaused` (§8.2), a sign-in, a sign-out or
a re-identify of the active replica (§7.12), and every `PULL_FALLBACK_MS` in the foreground (§7.9
**Timers**). Each run pulls the scopes of its trigger, each until `more = false`: a live gap its
scope, a subscribe the scope subscribed, a re-pull its scope, and every other trigger every
subscribed scope, those in doubt included. A scope with a pull in flight is not pulled again by a
trigger; the trigger marks it, and the answer's handling pulls it once more if it is marked or
`more`. A request names at most `PULL_MAX_SCOPES` scopes; a run over more sends several, and a run
left with no scope to pull (every one waiting for its governing record's create, §7.9) sends none.
Each run first reconciles the subscription set (§7.9). A pull answered `401`, or served as another
principal (§9.1), sets `authPaused` and applies nothing (§9.6).

**Live socket.** A replica that pulls keeps one live socket, which follows (`sub`) the scopes it
pulls as §7.9 states. An open that fails, and a socket that ends or fails (the server or the network
closes it, or a `ping` goes unanswered for `LIVE_PONG_MS`), count as a reconnect: the puller runs at
once. The client sends `ping` after `LIVE_PING_MS` with no frame or `pong` received. A close the
client makes (leaving the foreground, going offline, a sign-in, a sign-out or a re-identify) pulls
nothing, though the sign-in, sign-out or re-identify runs the puller itself (§7.12). Opening again
backs off as the sender does
(§7.4), with its own `k` and the 30 s ceiling: `k` rises with every failed open or ended socket, and
resets once a socket has stayed open 30 s. A `401` at the upgrade, where the
client can read it, sets `authPaused` too; a browser, which cannot, learns it from its next pull or
push. A frame served as another principal (§9.1) sets `authPaused`, applies nothing, and the client
closes the socket. A re-authentication that clears `authPaused` opens the socket again at once, with
`k := 0`. A `426` from any request stops sync until the app is upgraded (§9.6), on every tab (§7.8).

1. Update the offset (§10.4) before observing any stamp. A null `serverEpoch` takes the response
   epoch, with no epoch change: a replica holds no acked entry while its `serverEpoch` is null (§7.4),
   so none is passed over. A response epoch ≠ a non-null `serverEpoch` triggers an **epoch change**
   first. In one transaction:
   1. `serverEpoch := epoch`.
   2. Every cursor becomes `null`, and every staging is dropped.
   3. Every `acked` entry with `resultEpoch ≠ epoch` returns to `ready` at its commit position.
   4. Re-identify (§7.11).

   The epoch change is never split (§2.5). Split, a process death between its parts could leave
   acked entries of the old epoch that no rule returns to ready or resolves (INV-3), or ready entries
   numbered under the old replica id. Its work grows with the replica's scopes and its acked and sent
   entries, never with its rows: a re-identify touches no row (§7.11), and a staging it drops is
   deleted afterwards (§2.5).

   A restore is outside INV-3's condition. For example, a re-sent command may create its record
   again under a new `born`, and a pending delete already rewritten to the old `born` then ends as
   a no-op; and a notice may describe a record that a forked store later re-creates.
2. **Pages.** A `reset`, `gone` or `not-found` page applies in one local transaction. A rows page
   applies in one local transaction, or in several, its *chunks*, sized by §2.5's writer rule: each
   chunk takes the next rows of the page, whole and in the page's order. A page's chunks apply one
   after another, with no other page or frame of the scope between them, and each first checks that
   the page is not stale, that its scope is in the subscription set and that its replica is still
   active (§7.12); a chunk that fails a check applies nothing, and neither does the rest of the page.
   A page in one transaction is its own first and last chunk.
   - **Stale page.** A page requested with a cursor other than the scope's stored cursor is dropped,
     and the scope is pulled again, so a cursor never moves backwards.
   - **Scope outside the set.** A page for a scope outside the subscription set (§7.9), whatever
     cursor it was requested with, applies nothing and pulls nothing again: a forgotten scope holds no
     cursor, so a page requested with `null` would otherwise pass the stale check and land rows and a
     cursor the next reconcile deletes. A stale page of such a scope is not pulled again either. A
     known scope is outside the set, one an earlier page of the same answer made known included (a
     dead governing row): its own `gone` page applies nothing, and the next reconcile forgets it.
   - **`reset`:** the cursor becomes `null`, and any staging is dropped.
   - **Boot rows** go to staging when the boot starts from a `null` cursor while confirmed rows
     exist, otherwise straight in; the first chunk of the page requested with the `null` cursor
     decides, and starts that staging afresh; a later boot page's chunks join it. A thin dead derived
     row adds a `SpentId`. On the last chunk of the page that ends the boot's scan (its cursor turns
     live):
     - staging replaces the scope's confirmed rows, and its digest replaces theirs;
     - `booted := true`;
     - the cursor it stores, live at `asOf`, covers the acked entries of the scope with
       `resultSeq ≤ asOf`, which settle (**Settling**, below).
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
     - A `not-found` for a tree or overlay scope waiting for its governing record's create, or
       whose governing record is alive in `drawn` or in `stored`, a held delete's window included
       (§7.9).

     Otherwise:
     - delete the scope's confirmed rows, `SpentId` rows and cursor, record the scope as known with
       that kind, and unsubscribe;
     - acked entries of the scope resolve;
     - pending entries stay, and the server refuses them.
   - A subscribe and an alive governing row (§7.9) clear a `not-found` `KnownScope` record; nothing
     clears a `gone` one.
   - Every change to the scope's confirmed rows changes `CursorRec.digest`, and every change to its
     staging changes the staging digest (§6.12), in the chunk that makes the change.
   - Every chunk observes the stamps of its rows and updates `admittedHigh`. The last chunk stores
     the cursor.
   - Every chunk before the last sets `CursorRec.behind`. The last sets it when the page's `more` is
     true, and clears it otherwise.
   - The last chunk settles the acked entries its cursor covers (**Settling**, below), and then runs
     the digest check (step 4).

   **Between chunks.** Only a page's last chunk does what its cursor decides: it stores the cursor,
   ends a boot (the swap and `booted`), settles the entries the cursor covers, and runs the digest
   check (step 4). So a reader between two chunks sees what it would see had the server ended the page
   at the last row applied, except that none of those has happened; no record is torn, since chunks
   take whole rows. A process death between chunks keeps the chunks committed and loses the rest, and
   the scope's next pull, under the unmoved cursor, asks for the page again:
   - Applying it again changes nothing the chunks got right: each row it brings has a `seq` at least
     that of the row a chunk applied, and replaces it (§3.4). The chunks' rows changed at seqs above
     the cursor, so the pull, continued to its head, brings each in its state there (INV-5), and the
     check at the head compares like with like (INV-15).
   - A boot from a `null` cursor whose chunks went straight in finds their rows, so it goes into
     staging, whose swap replaces them; one whose chunks went into staging starts it afresh.
   - No frame applies inline over the chunks' rows, whichever socket brings it: the scope is
     `behind` until a page brings its cursor to the head (step 3).

   A chunk fails its check only after a transaction outside the page moved the scope's cursor (an
   epoch change leaves it `null`), took the scope out of the subscription set, or changed the active
   replica. It leaves the same state as a death, with the process alive.

   A straight-in boot's chunks are visible before `booted`, in the page's `(seq, type, id)` order, so
   a record can arrive before one it references (a roadmap `edge` before its `node`). The pages of a
   multi-page boot show the same, at a coarser grain. A product that must not draw a partly booted
   scope waits for `firstPullComplete` (§7.9; the domain kit's ER-3).

   **Settling.** A scope's stored cursor *covers* an acked entry of the scope whose `resultEpoch` is
   `serverEpoch` and whose `resultSeq ≤ cleanSeq`:
   - live cursor: `cleanSeq = cursor.seq`, or `cursor.seq − 1` while the cursor carries a key;
   - booting, or no cursor: `cleanSeq = −∞`.

   A covered entry resolves. The transaction that stores a cursor (a page's last chunk, a frame
   applied inline) settles the entries it covers: it resolves them all, or a first part in commit
   order and leaves the rest to *settling slices*, transactions of their own that follow it, sized by
   §2.5's writer rule. Slices resolve the rest in commit order, each only entries the scope's stored
   cursor covers when the slice runs: after a digest mismatch, a reset or an epoch change, a slice
   resolves nothing more. An `ok` whose `resultSeq` the stored cursor already covers resolves in its
   result's batch (§7.4): its own entry, and no other.
   - **Readers.** Between two slices, a reader sees the covered entries not yet resolved still
     pending, as before their cursor covered them: their deltas and predictions fold into `drawn` and
     `stored` (§7.6) over the newer confirmed rows. A lattice register reads the confirmed value, of
     which the entry's write is already part; a text field reads the newest pending text, which may
     be the entry's; a record the page deleted reads as the entry wrote it.
   - **Death.** A process death between slices keeps the resolutions committed, and the entries left
     stay `acked`, covered and pending. The next transaction that stores the scope's cursor settles
     them: the scope's next pull, which a launch makes, stores a cursor at least as far on. A result
     settles no entry but its own. A reconcile that finds the scope outside the set (§7.9), a `gone`
     or `not-found` applied to it, and a sign-out (§7.10) resolve them as they resolve every acked
     entry, and an epoch change returns them to `ready` as it returns every acked entry of another
     epoch.
   - **What a slice leaves alone.** A slice changes no row, digest, cursor, stamp or `behind`. The
     digest check (step 4) runs in the transaction that stores the cursor, and INV-15 speaks of that
     transaction, so neither depends on how far settling got.
3. **Live frames.** A frame applies in one local transaction, and its settling may go on in slices
   (step 2). A `change` frame is applied as a live page iff the cursor is live without a key, the
   scope is not `behind`, `epoch` matches, `seq = cursor.seq + 1`, and `rows` is present. Otherwise
   pull. A `gone` or `not-found` frame is handled as that page kind (step 2: applied, ignored, or
   outside the set). A scope `behind`
   may hold a row older than its state at the cursor's seq (changed below the cursor and again above
   it, so a page short of the head skipped it), or rows past the cursor (chunks a death cut short). A
   `change` frame, which may arrive late on any socket, would then check its digest against rows that
   are not the server's at its seq.
4. **Digest check.** When, after a page's last chunk or a frame is applied, the cursor is live,
   carries no key and its seq equals the page's or frame's `seq`, and no staging is pending, the
   client compares its digest with the received one, in that transaction. This covers a live page
   that reaches the head, a frame applied inline, and a boot whose `asOf` scan has ended and caught up
   to the head. On a mismatch:
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
     5. Every *unsourced* stamp of a held or ready entry takes the lesser of itself and the
        recovered clock's reading: step 2's pair with the recovering instance's actor. A stamp is
        unsourced when it is a born, or a life register the entry carries unchanged, that exceeds
        `admittedHigh` and that no held, ready or sent entry wrote, by a delta or a prediction, all
        as they stood before step 4. Its source is a command's prediction whose `ok` gave that
        register no stamp (the write map, below): no server checked it, and no restamp moves it.
        Lowered, it passes §6.1 step 2, and a carried life register out-stamps nothing it did not
        out-stamp before.
     6. `meta.hlc` and `hlcHigh` become `max(admittedHigh, the new stamps)`, shared by every tab.
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
   guards read `stored` (§7.1 step 6), which holds held-back entries and no held ones. After an undo,
   retire or supersede (§7.3) the guard holds in the first case, and in the second the fold empties that
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

**Write map.** An `ok` result's write map applies in the result's batch (§7.4). Let `s` be the
command entry's stamp, which every register it predicted carries. Steps 1 and 2 run for each map
entry `w`, then step 3 once for the map:
1. `w.from` is present only when the resolved id differs from the id the command was called with,
   which means the record existed before the command (a join). It is replaced by `w.id` in every
   held and ready entry (delta ids, key parts, `ref<w.t>` fields and arguments), in `predict`, and
   in device rows (a product hook). The exception is an entry whose delta deletes `(w.t, w.from)`:
   it is not rewritten, and is refused `target-merged` by steps 2–4 above.
2. The command's own `predict` is restamped by the restamp rule, with `n` given by the map:
   `w.f[f]` for each field, and `w.born` for the life of a record it created or resolved to. Later
   borns and guards naming the stamps its predicted registers carry follow. A predicted register
   the map gives no stamp keeps its predicted one: the command wrote nothing for it, as a replay by
   receipt of a record that is gone writes nothing (A.2). A later entry that carries it as a born or
   a life is lowered by step 1.5 if the server refuses it `clock-skew`. The predict stays drawn
   until its entry resolves, once the cursor covers `resultSeq` (§7.5 step 2).
3. The client observes every stamp in the map and raises `admittedHigh` to them. Then it restamps,
   by the restamp rule with fresh ticks, the registers the map names (a field in `w.f`, or the life
   of a `w` with `born`) in every held or ready entry that writes them. A later local write
   therefore follows the command it came after (INV-1).

No entry is `sent` behind a command (§7.4), so every reference, born and guard is rewritable.

**Restamp rule.** Used by `clock-skew` recovery and by the write map (steps 2 and 3). It moves only
registers an entry wrote, which carry a stamp at or after the entry's `stamp`. A register an entry
carries unchanged (a keyed put's drawn life, §7.1 step 4) moves only with its source, or, unsourced,
by recovery's lowering (step 1.5). The registers
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
A process death between two result batches of one response can leave such an entry rewritten
before its own result is recorded; its resend then carries another digest, the server answers
`replica-forked`, and the replica re-identifies (§7.11), with nothing lost.

### §7.8 Multi-tab (web)

- The leader holds `navigator.locks` lock `wm-sync:<replica>` and runs the sender, the puller and
  the live socket.
- A tab requests the lock when it becomes visible. A hidden tab releases it once a peer announces
  it is visible.
- Tabs post `hello {visible}`, `visible`, `hidden`, `bye`, `changed(scope, ids)`, `upgrade` and
  `activeReplicaChanged(previous, replica)` on `BroadcastChannel('wm-sync:<replica>')`, and a tab
  answers a peer's `hello` with its own. A tab that knows no other live tab is the last tab. A tab
  that receives a `426` posts `upgrade`, and every tab then stops sync until the app is upgraded
  (§7.5). A tab whose transaction changes `activeReplica()` posts `activeReplicaChanged` on the
  channel of the replica it replaced, and every tab delivers the event (§7.12). A tab compares
  `activeReplica()` with its channel's id on every `hello`, `visible` and lock acquisition, and
  rekeys its channel and lock.
- Every tab holds the lock `wm-tab` in shared mode while it lives. A tab that finds it unheld
  (`navigator.locks.query()`) when it starts is the first tab.
- Every tab reads views from IndexedDB and commits through §7.1.

### §7.9 Subscriptions

A bound replica subscribes the product scopes of the products its surface carries (the registry's
`surfaces`), and no scope of another product. It also subscribes the tree and overlay scopes its
product binding lists (A.1): the set holds a tree and its overlay per governing record alive in
`drawn` or in `stored`, so a held create's tree is in it, and so is a tree inside its governing
record's delete window, so an undo finds its rows. It also subscribes any `tree/<T>` while it is open: the engine exposes
`subscribe(scope)` and `unsubscribe(scope)`, which a product calls when it opens and closes a tree.
A subscribe deletes a `not-found` `KnownScope` record; the scope has no cursor, so its first pull
boots it. A `gone` record stays, since a scope's death is final (INV-13): a subscribe to it answers
`gone`, and nothing is pulled. An alive row of the governing type, arriving in any page or frame,
deletes a `not-found` record of its `tree/<id>` and `self/overlay/<id>` alike: the tree the record
denies exists, so the answer that wrote it is stale (a restore, then a create re-sent after it). The
scopes rejoin the subscription set, so the next puller run pulls them (§7.5). An `anon` replica
pulls only readable trees it opens. Every scope a replica pulls is held in full: a boot sends every
alive row (§6.7).

A tree or overlay scope whose governing record's create is still in the outbox, held, ready or sent
(by a delta or a prediction), stays in the subscription set but is neither pulled nor subscribed
(`sub`) on the live socket: the server holds no such scope yet. Both start once that entry has its
result, the `sub` of a scope in doubt once that pull has brought rows (below). A `not-found` page or
frame is ignored, and writes no `KnownScope`, for such a scope and for any tree or overlay scope whose governing record the replica holds alive, in `drawn` or in `stored`
(§7.6): its create acked but not yet confirmed, the record confirmed, or a held delete of it
waiting, which leaves it alive in `stored` only. Such an answer is stale: the server wrote it before
it held the scope, as when a pull that left before the create was committed, or a `sub` answered
before it, lands after the create's `ok`. A `gone` needs no exception, since a tree that exists only
in the outbox cannot have died.

**Following.** While the live socket is open it *follows* the scopes it has sent `sub` for, less
those it has sent `unsub` for and those a `gone` or `not-found` frame named, applied or ignored: the
server keeps no subscription for them (§6.8). A socket that opens follows none. The socket keeps
this set in step with the subscription set: it sends `sub` for each scope of the subscription set it
does not follow, unless the scope waits for its governing record's create (above) or is in doubt
(below), and `unsub` for each scope it follows that left the subscription set.

**Doubt.** An ignored end, a `gone` or `not-found` page or frame that §7.5 step 2 ignores, puts its
scope *in doubt*, unless it is already. A rows page of the scope, applied, ends the doubt and drops its
scheduled re-pull. While a scope is in doubt:
- the socket does not `sub` it. A scope the doubt began with an ignored frame is so not followed until
  the doubt ends; one it began with an ignored page stays followed if it was;
- one re-pull of it is always scheduled or in flight. The doubt's start schedules the first, and a
  re-pull that ends with the scope still in doubt, answered by another ignored end or not answered
  within `REQUEST_TIMEOUT_MS` (a transport error), schedules the next. Each is scheduled `random(0, min(30 s, 1 s · 2^k))` after its cause, then
  `k += 1`, with the scope's own `k` (Appendix B's re-pull backoff). A re-pull pulls its scope alone.
  While the governing create is still in the outbox it waits for the create's result, which pulls
  the scope (above);
- the pulls of every other trigger (§7.5) take the scope as they take any subscribed scope, and leave
  its re-pull and its `k` as they are.

The scope's `k` returns to 0 once the scope has been followed, and not in doubt, for 30 s in one
unbroken *stretch*. A stretch begins at the later of the `sub` that began the current following and
the end of the scope's last doubt. It ends when the following ends (an `unsub`, the socket's close,
a `gone` or `not-found` frame as it arrives) or when a doubt starts. The reset is checked when a
stretch ends, however it ends, and again at the ignored end that starts a doubt, before its first
draw: a stretch that lasted 30 s or more returns `k` to 0. Stretches are measured on the monotonic
clock, as the puller's timers are; a device clock jump neither lengthens nor cuts one. So a stretch
of 30 s since the last doubt counts even when a close ended it before the next doubt; time in doubt
or unfollowed never counts. A scope that leaves the subscription set loses its doubt and its `k`, and
a sign-in, a sign-out or a re-identify of the active replica (§7.12) ends every doubt and returns
every `k` to 0, whether or not its id changed. Doubts and `k`s are not stored: a process starts with none. INV-16 bounds what they
cost.

**Timers.** The puller's timers, `PULL_FALLBACK_MS` and every scheduled re-pull, run only while the
app is in the foreground (§7.3 defines leaving). A re-pull whose time comes in the background is due:
a puller run in the background for another trigger takes it with its own scopes. Returning to the
foreground pulls every subscribed scope (§7.5). `k` keeps its value across the background.

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
  2. The product's sign-out confirmation MUST state the count of ready and sent entries plus durable
     pending work held in product device rows, and offer
     Keep or Discard when any remain, and a plain confirm, which is Keep, when none do. The engine
     exposes the ready, sent and pending counts: a sent entry may already have landed. A product
     hook identifies its pending device-row keys; each such row counts as one additional work item.
     Keep covers every entry and device row, counted or not. A Discard covers exactly the work it
     counted: the engine pins entry local ids and pending device-row keys with their full-value JCS
     SHA-256 digests, and when they differ at the answer (a result or another edit), it asks again
     with the new count.
  3. The finish, in one local transaction. Acked entries resolve: the server holds them. On Keep:
     delete A's confirmed rows, `SpentId` rows, cursors, `KnownScope` rows and staging, preserve its
     durable product device rows, and set `state := dormant`; remaining entries and pending work
     resume on the next sign-in as A. On Discard:
     delete the replica with its device rows, and its entries end `discarded`. Discard removes them from this device; it
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
both places, without re-identifying. A re-identify changes `ReplicaMeta.replica` and nothing keyed
by it: a store keys rows, entries, cursors, notices and device rows by a handle of the replica that a
re-identify leaves alone, and the id lives in `ReplicaMeta` alone. Its work grows with the replica's
`sent` entries, never with its rows. Re-identify, in one local transaction per replica:
1. Mint a new replica id. The re-identifying engine instance takes a new actor; other instances
   take one at their next launch (D-2).
2. `nextN := 1`, and `ackThrough := 0`.
3. Every `sent` entry returns to `ready`. The sender numbers them again in commit order, with new
   digests.

### §7.12 The active replica

One replica of the device is **active**: the one `commit` (§7.1), the views (§7.6), the sender
(§7.4), the puller and the live socket (§7.5) act on. It is the `bound` replica while an account is
signed in, and otherwise the `anon` replica, which stays active through an incomplete sign-in
(§7.10). A re-identify changes the active replica's id, not which replica is active. A page or frame
that arrives for a replica no longer active applies nothing; push results still in flight are
recorded in the replica that sent them (§7.10).

The engine exposes:
- `activeReplica()`: the active replica's id (D-3).
- The event `activeReplicaChanged(previous, replica)`: `activeReplica()` answers `replica` where it
  answered `previous`. It follows every transaction that changes that answer, and no other:
  - a re-identify of the active replica (§7.11): at engine start by the fork guard, after a push
    answered `replica-forked`, `replica-foreign` or `gap` (§7.4), and in an epoch change (§7.5
    step 1);
  - a completed sign-in (§7.10) whose `bound(A)` replica is a `dormant(A)` replica bound again, or a
    new replica. One that rebinds the `anon` replica keeps its id and fires none;
  - a finished sign-out (§7.10), which makes the `anon` replica active.

  A re-identify of a replica that is not active, such as a dormant one whose in-flight push is
  answered `replica-forked`, fires none.
- The id of the replica a commit writes to, given to its read-and-commit function (§7.1), so a
  record that names its writer, such as the gym Coach's `message.replica` (gym Coach §9.1), names it
  exactly.

The event is delivered after its transaction commits, once per change, in the order of the changes.
It is not durable: a change whose process dies before delivering it is announced by no later event,
so whoever holds an id reads `activeReplica()` again at engine start, or keeps a durable mark of
its own, such as the gym Coach's `runningTurn` device row (gym Coach §4.5). On web every tab delivers
it (§7.8).

A sign-in, a sign-out or a re-identify of the active replica runs the puller (§7.5) and ends every
doubt (§7.9), whether or not its id changed.

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
| `held`, `ready` | anonymous gesture superseded (§7.1 step 4), or emptied by the silent fold of an undo, retire or supersede (§7.3) | `undone` (no notice) |
| `held`, `ready` | folded as a dependent (§7.7) | `refused` (in the dependency's notice) |
| `held`, `ready` | a write map merges its delete target into an existing record (§7.7) | `refused` (`target-merged`, a notice) |
| `sent` | `ok` | `acked` |
| `sent` | `clock-skew`, `base-unknown` | `ready` (recovered, same position) |
| `sent` | another refusal; a 400 or 413 on a one-intent request (§7.4) | `refused` (a notice, or none for an orphan) |
| `sent` | transport error, 401, 503, `retry`; a 400 or 413 on a several-intent request (halved, §7.4) | `sent` |
| `sent` | re-identify (fork guard, `replica-forked`, `replica-foreign`, `gap`, epoch change) | `ready` |
| `sent`, unprocessed | an earlier entry's `clock-skew` recovery (§7.7 step 1); a 400 or 413 on a one-intent request at a lower `n` (§7.4) | `ready` (restamped after a skew) |
| `acked` | its scope's stored cursor covers it (`cleanSeq ≥ resultSeq` in the same epoch; a boot's end at `asOf`), settled by the transaction that stores the cursor, a settling slice after it, or the `ok` itself (§7.5 step 2); scope `gone` or `not-found`; the scope leaves the subscription set (§7.9); sign-out (§7.10) | `resolved` |
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

JSON over HTTPS and WebSocket. Every response carries `serverTime` and `epoch`, except a transport's own
`400`, `413` or `501` (below). Every request carries the registry version, on every surface: hello, push
and pull in the header `Sync-Schema`, and the live socket's upgrade request, to which a browser
`WebSocket` cannot add headers, in the query parameter `schema` (`/v1/sync/live?schema=<version>`).
The server reads each request's version from that carrier only, as its HTTP framework presents it. A
missing value, or one that is not a decimal integer, → `400 malformed`; a version below the server's
`minSchema` → `426 upgrade-required`. A change to any request or response envelope shape raises
registry `version`, and `minVersion` with it (§2.4), so a client that speaks the older shape is answered
`426` at the version check, never `400` at the shape check. A browser cannot read the status of a
refused upgrade, so a web client learns a `426` from its hello, push or pull (§7.5). Keyed ids
declared as arrays (`edge: [from, to]`) have their `jcs` as identity.

**Credentials.** The origin MUST consider every occurrence of `Authorization`, and of the session
cookie `wm_session` in every `Cookie` field line, as received; header names compare in ASCII case
only. Any edge in front of it (a reverse proxy) MUST forward these fields without removing, merging
away or reordering occurrences, and MUST NOT rewrite them. Every `Authorization` header and every
session cookie is a credential sent, whatever its shape. A cookie's token is its value with only
space and tab trimmed around it (RFC 6265): no quote is stripped and nothing is unescaped. The
credentials resolve, making the request their account's, only when the request sends at most one
`Authorization` header and at most one session cookie, each of its form
(`Authorization: Bearer <token>`, `wm_session=<token>`) and each token held by a live session, and a
cookie and a header sent together name one account. For every other request that sends a credential,
the server MUST answer `401 unauthenticated`, on hello, push, pull and the live upgrade alike: two
`Authorization` headers; a scheme other than `Bearer`; two session cookies, in one `Cookie` field
line or across several; a bare or malformed session cookie (a `wm_session` with no `=`, or an empty
value); a cookie and a header naming different accounts; a token revoked, expired or unknown. It
MUST NOT serve such a request as anonymous, or under any single one of its credentials. A request
that sends no credential is anonymous: its push answers `401`, its hello carries no `holdsRecords`
(§9.2), its pull answers `not-found` for every `self/…` scope (§6.7), and its live socket serves
only the trees it can read (§6.8). A conforming deployment passes these cases
(`envelope/credentials`, §11.1) both against the origin directly and through its edge, over HTTP/1.1
and HTTP/2.

**Session cookie scopes.** The deployment keeps the list of every scope it has set the session
cookie in: host-only, and each `Domain` it has configured, the current one and every earlier one. A
response that sets the session cookie writes the live cookie in the current scope first, then
expires it in every other scope on that list; a response that clears it expires it in every scope on
the list. The live cookie comes first because a client that takes the first `wm_session` of a
response, as the Android app does, then gets the live one. A stray variant left by a change of
`Domain`, which a browser would send beside the live one, never outlives the next sign-in or
sign-out. A deployment whose configured `Domain` differs from the host that answers sign-in and
sign-out never writes the same cookie twice in one response. One whose `Domain` equals that host
(the only `Domain` a site served at its registrable domain can set) relies on its clients: a store
that takes a host-only cookie and a `Domain=<host>` one as the same cookie (RFC 6265 §5.3) would
lose the live cookie to the expiry that follows it. So every client of such a deployment MUST keep
the two apart, as Chrome does for a host under a registrable domain, read the first `wm_session` of
a response, as the Android app does, or keep no cookie, as the iOS engine's transport does, which
sends its token as `Authorization: Bearer`. At `localhost` Chrome files `Domain=localhost` as
host-only, so the expiry that follows the live cookie removes it: a deployment served at a host with
no registrable domain (`localhost`, an IP address, any single-label name) configures no `Domain`. The
server refuses to start with a `Domain`, current or earlier, that is an IP address (an IPv6 literal,
or a name whose last label is a decimal or `0x` number), a single label, a name whose last label is
`localhost`, or not a host name of letters, digits, `-` and `.` with at most one leading dot; it names
each scope once, whatever its case or leading dot (RFC 6265 §5.2.3), so no response writes the same
cookie twice. A `Domain` that is a public suffix is the browser's refusal, not the server's: it
ignores the cookie at every host but the suffix itself (RFC 6265 §5.3).

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
The transport and the edge MAY refuse a request that is not valid HTTP before these checks. Over
HTTP/1.1 (RFC 9112 §5, §6.1, §6.3) that is a field name that is not a token or is followed by
whitespace, a field line with no colon, a folded line, a bare CR or LF, `Content-Length` sent twice or
beside `Transfer-Encoding`, or a `Transfer-Encoding` other than `chunked` alone, answered with a bare
`400`, or a bare `501` for a transfer coding it does not implement (RFC 9112 §6.1). Over HTTP/2 (RFC
9113 §8.2) it is those, an uppercase letter or a byte outside 0x21–0x7e in a field name, a field value
that starts or ends with space or tab, or a connection-specific field, answered by resetting the stream,
with or without a `400` first. A request is refused for its syntax, never for what it carries: a
`Cookie` or `Authorization` line of any value, sent any number of times, is valid HTTP and reaches the
checks. A client never sends such a request.

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

The corpus runs against the probe product (`packages/api-contract/sync/probe.registry.json`), but
for its `gym/` and `journal/` files, which run against their product registries and bindings (A.2,
A.3). Its `README.md` states its conventions, and `constants.json` holds the constants its
vectors assume.

| Role | Files |
|---|---|
| all | `constants.json`, `stamp/{order,codec}`, `hlc/{tick,observe}`, `jcs/values`, `join/{lww,ranked,fww,life,born,record}`, `derive/slug`, `identity/seeded`, `digest/{row,scope}`, `protocol/*.jsonl` (hello, push, pull, live, join, skew and whole transcripts) |
| server | `identity/table` (every §4.3 cell), `admit/*`, `text/{tokens,script,diff3,merge}`, `envelope/credentials`, `push/serve`, `pull/{serve,hello}`, `live/death`, `machine/scope`, `gym/admit`, `journal/admit`, `journal/revisions` |
| client | `hlc/{offset,jump}`, `fracindex/{between,drop}`, `view/{drawn,stored}`, `commit/*`, `hold/{release,undo}`, `refusal/{fold,restamp,base-unknown,transport}`, `write/map`, `lineage/{signin,signout,start}`, `pull/pages`, `machine/{intent,replica}`, `journal/client`, `journal/content-clock` |

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
- process death between local transactions, two chunks of a pull page and two of its settling slices
  (§7.5 step 2) and two batches of a push answer's results (§7.4) among them;
- pull pages that end short of the head (`more`), with frames arriving between them;
- clock error of ±10 min, and device clock jumps;
- holds, undo, retire, supersede, leaving the app, and activity or scene recreation;
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
nothing the replica pulled (§9.1), and **at every step** that each change of a device's active replica
id was announced by one `activeReplicaChanged` naming the id it replaced (§7.12).

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

**Coverage floor.** Each simulator counts the events of its coverage list, which names at least one
event for each fault above that it injects, and a fuzz (one run of the simulator over its seeds) fails
when a listed event never occurred in it. Each event is listed with a fuzz size, seeds × steps, at
which ten or more of its seeds, on average, produce the event, and no first seed misses it. The corpus
README states the rule and the reference's sizes.

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
  every `tree` and `track` record alive in `drawn` or in `stored`.

### A.2 Gym

**Scope:** `self/gym`. **Device scope** `device/gym`, with rows keyed per session:
`movementOrder:<session>` (the live movement order, exercise ids), `movement:<session>` (the chosen
movement), `offer:<session>` (a pre-minted offer id) and `rack:<session>` (rack state).
**Surfaces:** web, iOS, Android. MCP, the Coach and the import door write as the server (below).
**Adoption:** production tables are adopted in place (Appendix C).

Every minted type mints 16 base-62 characters and is seeded (D-8): a seed of at most 58 characters,
and `n ≤ 99 999`. Minted ids match `^[A-Za-z0-9_-]{8,64}$`, except `exercise` ids, which match
`^[A-Za-z0-9_-]{1,64}$`: seed exercise slugs such as `dip` are shorter. The seed exercises are a
catalog outside every scope (§0): each seed id is `foreign` to every account, as the binding's
`elsewhere` reports it (§2.3). **Primary types** (§9.2): `routine`, `session`, `set`, `note`,
`weighin`, `exercise`.

| Type | Identity | Life | Fields | Rules |
|---|---|---|---|---|
| `routine` | minted g | terminal, spent | lww: `name` 1–240 bytes, `position` an integer 0–2 147 483 647 (default 0), `entries` (`maxItems` 50 of {`exerciseId` (the only required key), `restSeconds` 15–900, `sets` (`maxItems` 20 of {`reps` 1–100, `weightKg` ±500 quantum 0.01})}); lww server: `revision` 1–2 147 483 647; const server: `createdDoor` ∈ {mcp, ask}, `createdEntries` 0–2 147 483 647 | `entries` holds one entry or more, and an entry's `sets`, when present, one set or more (`invalid`): an absent `sets` is the open line, a set's absent `reps` is max and its absent `weightKg` last time's, and an absent `restSeconds` the lifter's rest target. Editor save guards the fields it writes. Changing `name` or `entries` supersedes its pending proposals, every door's, with no `supersededBy`. Delete kills its proposals and writes `routineId = null` on its sessions. `createdDoor` is the agent door that created it, unset for the lifter's hand. R118: server-authored revision and original entry count; an ask create also writes the independent `routineCreation` snapshot below. |
| `routineCreation` | keyed string, same id pattern as routine; no ref | none | const server: `snapshot` JSON | R118: exact immutable Coach creation receipt, in `gym_routine_creations`; survives routine/conversation deletion, purged only with its account. Not a primary type. No public writer. |
| `exercise` | minted g | terminal, spent | lww: `name` 1–240 bytes; const: `pattern` ∈ {squat, hinge, press, pull, carry, core, isolation}, `equipment` ∈ {barbell, dumbbell, machine, cable, bodyweight, kettlebell}, `stepKg` 0.01–99.99 quantum 0.01; lww server: `aliases` (`maxItems` 5 of 1–240 bytes) | Never deleted (a delete is `invalid`). A create carries `stepKg` (`invalid` otherwise). A change of `name` writes `aliases :=` the name it replaced, then the aliases less that name and the new one, the first 5: newest first, so the name it holds is never an alias. |
| `exerciseName` | keyed (`ref<exercise>`, a seed) | none | lww: `name` 1–240 bytes; lww server: `aliases` as an exercise's | A seed's name for the account: `name` unset reads as the seed's own name, and a seed renamed back to it holds it. Keyed by an id that is not a seed → `invalid`. A change of the displayed name writes `aliases` as an exercise's rename does. |
| `session` | minted g | terminal, spent | lww server: `routineId` `ref<routine>` or null, `startedAt` an epoch ms, `finishedAt` an epoch ms, `closedBy` ∈ {finish, stale}, `displayName` ≤240 bytes or null; const server: `historyRoutineId` (the routine it started from, kept after that routine's death), `plan` JSON or null | Created only by commands. At most one session with `finishedAt` unset per account. `closedBy` is unset while `finishedAt` is, and on a session finished before gym recorded who closed it (Appendix C), which every rule reads as `finish`. A delete of a session whose `finishedAt` is unset is refused `session-open`, unless its last activity is 4 h or more before `serverNow`. Delete kills its sets. |
| `set` | minted g | terminal, spent | `sessionId` const `ref<session>` parent; `exerciseId` const `ref<exercise>`; `setNumber` serial 1–2 147 483 647, next `[sessionId, exerciseId]`; lww: `weightKg` ±500 quantum 0.01, `reps` 1–500, `kind` ∈ {warmup, working, drop, failure}, `rpe` 1–10 or null quantum 0.1, `note` ≤4000 bytes, never null, `completedAt` an epoch ms | Set rules below. |
| `note` | minted g | terminal, spent | lww: `title` 1–60 chars, `body` ≤500 bytes, `ord` (D-25); lww server: `updatedAt` epoch ms ≥0 | Cap 10. Editor save guards the fields it writes. Client-derived `position` is the dense rank from 0 of `(ord, id)` among alive notes. R118 `updatedAt` is its content admission time; reorder leaves it alone. |
| `weighin` | keyed (local date `YYYY-MM-DD`) | yes, spent; `wholePut` | lww: `kg` 20–400 quantum 0.01, `recordedAt` an epoch ms | `check` refuses an alive put of a day later than the day after `serverNow`'s UTC date with `bad-instant`. A weigh-in is one fact (§2.4): each put writes `kg`, `recordedAt` and presence at one stamp, so the newest stamp wins whole, and a newer put than a delete, held or not, keeps the weigh-in. A replica writes `recordedAt` from the read-and-commit function's `now`. No server-origin door writes a weigh-in. |
| `prefs` | singleton | — | lww, with registry `default`s (§2.4): `units` ∈ {kg, lb} (kg), `restSeconds` 15–900 or null (null), `restSound` (true), `confirmHaptic` (true), `confirmSound` (false) | Phones edit `units`, `confirmHaptic`, `confirmSound`. |
| `proposal` | minted g | terminal, spent | const: `routineId` `ref<routine>`, not a parent; `intent` ∈ {revise, remove}; `proposedName` ≤240 bytes; `summary` ≤400 bytes; `changes` (`maxItems` 100 of {`kind` ∈ {kept, added, removed, retargeted}, `exerciseId`, `before`, `after`}, each side {`sets`, `restSeconds`} as a routine entry's); `door` ∈ {ask, mcp}; `connection` ≤128 bytes; `agent` ≤64 chars; const server: `baseRevision` 1–2 147 483 647, `baseName` ≤240 bytes, `changeCount` 0–2 147 483 647; lww server: `threadId` (a Coach conversation's id) or null, `state` ranked (pending 0; applied, dismissed, superseded 1; unset reads `pending`), `supersededBy` (the proposal that replaced it), `settledAt` an epoch ms | Rules: [gym Coach](mobile/gym_coach.md) §9.2, §11. `changes` lists the lines the routine takes on, in order, then the lines it drops; `before` is on kept, removed and retargeted lines, `after` on kept, added and retargeted ones. A replica's create requires `door = ask`, and `connection` and `agent` empty or unset (`invalid`), and carries a guard (D-19) on every routine register its content is based on, `entries` and `name`, at the stamps it read; a moved stamp → `stale`. For a replica create, `check` requires both guards to match the joined routine registers (`invalid` otherwise). For every create, it matches each proposed line to the first unmatched base line of the same exercise; equal sides are `kept`, unequal sides `retargeted`, unmatched proposed lines `added`, then unmatched base lines `removed` in base order. The supplied changes must equal this diff. A revision leaves 1–50 entries, a name that is not blank (below) and no empty set scheme; a removal leaves no proposed entries. A create whose `routineId` is absent, `foreign` or dead → `unknown-record`. A create supersedes the pending proposal of the same `(routine, door, connection)`: `state = superseded`, `supersededBy :=` the create's id, `settledAt := serverNow`, written before the new proposal is inserted; at most one is pending per `(routine, door, connection)`. R118 freezes `baseRevision`, `baseName` and `changeCount` at creation from the joined routine; later settlement never rewrites them. |

**R118 — metadata and REST parity.** Today's behaviour and design canon bind gym's registry.
The adopted columns already hold the facts below; the wire carries them as ordinary stamped
fields in `f`, using existing `lww` and `const` joins (§3.2). There is no new projection wire or
field kind. All seven additions are **(b) registry fields**, server-authored and read-only to
clients. A public replica delta writing one is `invalid`; a server-origin door MUST NOT supply
one either. The binding computes them in `check`, in the admitting transaction, before hashing
the final rows. An independent `routineCreation` has no life or reference to a live routine;
the binding refuses every public delta of that type, including an empty delta. Its absent
`primary` declaration means it does not change `holdsRecords`.

| Fact | Wire field / merge | Authority and writes |
|---|---|---|
| Routine concurrency revision | `routine.revision`, integer 1–2 147 483 647, server `lww` | Create sets 1. One admitted net change of `name` and/or `entries` adds 1 exactly once, including `gym.applyProposal` revise. Position-only writes, equal-value restamps, losing writes, refused intents and receipt replays add nothing. At the integer ceiling a document change is `invalid`; never wrap. Project every joined routine's final revision before freezing any same-intent proposal. |
| Original line count | `routine.createdEntries`, integer 0–2 147 483 647, server `const` | Every successful routine create, through any door, sets the joined creation `entries.length`. Edits, apply, reorder and retries leave it alone. Historical SQL NULL leaves the register absent, with no default; REST omits `history.created.movements` in that case. |
| Original Coach routine | `routineCreation.snapshot`, JSON, server `const` | An ask routine create writes this independent keyed record in the same intent and seq. Historical and new snapshots share one shape: the exact REST `toJson(Routine)` response at creation, with id, name, position (default 0), revision 1 and entries numbered from 1. No command sets it; `gym.applyProposal` edits/deletes an existing routine. Manual/MCP creates have no snapshot. Edits and routine/conversation death preserve it; account purge removes it. It is the engine view of the existing `gym_routine_creations.routine`, not a duplicate receipt table. |
| Frozen base revision | `proposal.baseRevision`, integer 1–2 147 483 647, server `const` | Every proposal create freezes the joined routine's final revision after all same-intent routine changes. `gym.applyProposal`, `gym.dismissProposal`, supersession and receipt replay leave it alone. |
| Frozen base name | `proposal.baseName`, string ≤240 UTF-8 bytes, server `const` | The same create freezes the joined routine's name. Empty historical values remain readable; no default or substitution of today's name. Settlement never writes it. |
| Apply count | `proposal.changeCount`, integer 0–2 147 483 647, server `const` | The same create freezes the store's count against that joined base. Count every non-`kept` diff row, add one when `baseName ≠ proposedName`, and add one for a reorder: visit kept/retargeted rows in proposed order, matching each to the first unmatched base entry of the same exercise; any matched base index below the greatest visited index means one reorder. Added/removed rows do not participate in that order check. Settlement and replay preserve the count. |
| Note content time | `note.updatedAt`, integer epoch ms ≥0, server `lww` | A note create or an admitted net title/body value change writes `serverNow`, including Coach's appended note. Ord-only reorder, equal content, losing writes and retries preserve it. No gym command sets it. Its stamp is the ordinary §10.3 server stamp, not the time value; `ru` still describes every envelope change. |

**(a) Exact client derivations.** Note position is the zero-based index after sorting alive notes
by `(ord, id)` in byte order; no position field is added. Routine creation chronology and
proposal `createdAt` use their confirmed `rc`, which adoption retains from `created_at`.
The movement count on an immutable Coach creation receipt is `snapshot.entries.length`; this
does not supply an unknown routine-history count. The six scalar facts above cannot be derived
from today's wire: a pull seq or register stamp is not a routine revision or a frozen base;
current entries/name are not their original values; the diff omits the frozen base ordering
needed for a reorder count; and reorder changes `ru` while preserving note content time.
No missing fact uses **(c) a separate server-derived read projection**: server computation is
carried by these existing field primitives, so pulls, command results, live reads and caches
share the same authoritative values and digest.

Clients render these fields from confirmed records, retain them through storage/restart and
display missing historical values as absent. They MUST NOT invent metadata in predictions,
restamp server fields or use a creation snapshot's administrative `rc` as a historical creation
date. Public write maps do not claim the binding's metadata fields. The scalar names match
`web/src/products/gym/syncProjections.js`; creation receipts read the independent record by the
routine id, including when that routine is spent.

**Evidence:** [gym architecture §§3.7–3.9](../../backend/products/gym/ARCHITECTURE.md),
[stored columns](../../backend/db/schema.sql) (`gym_routines`, `gym_proposals`, `gym_notes`,
`gym_routine_creations`),
[TypeStore reads/writes](../../backend/products/gym/sync/adapters/postgres/PgGym.cpp),
[count and revision rules](../../backend/products/gym/sync/domain/GymRules.cpp),
[nullable history count and creation replay](../../backend/products/gym/adapters/postgres/PgProgramRepository.cpp),
and [Coach canon](../design/gym/briefs/09-coach.md) (creation receipts, Apply's store count and
history from stored evidence), [Notes canon](../design/gym/briefs/10-notes.md).
`web/test/products/gym/restParity.test.js` checks the web's projections against 36 captured REST
reads.

**Coach conversations** (gym Coach §9.1) are not engine records yet: they stay in the gym backend's
Coach tables, and the phone Coach adds `thread` and `message` to gym's registry, with their binding
(§2.4). A proposal's `threadId` names such a conversation. Deleting a conversation first admits, as
the server, `threadId = null` on every proposal that names it.

**Cross-record checks** read stored records with the intent’s joined records and earlier staged
consequences over them. Consequences run in intent order. A routine’s death clears `routineId` on
sessions created by the same intent, retaining their frozen `plan` and `historyRoutineId`. For
same-key proposal creates, each supersedes stored and earlier created pending proposals; the last
create is pending.

**Display names.** `routine.name`, `exercise.name`, `exerciseName.name`, `note.title` and a revision's
`proposedName` are blank when they hold nothing but whitespace, the set §6.11 tokenises on. A create
or a write setting a blank name register is `invalid`, including a newer stamp carrying the same
blank value, whoever writes it. Clients trim before they write; admission keeps a name as it arrives.
A historical blank name stays readable and permits writes to other fields. A revision proposal
may replace it with a valid name, and a removal proposal may retain it. Neither proposal validates
the historical `baseName` as a new name.

**Set rules** (`check`):
- A supplied or automatically assigned `setNumber` outside 1–2 147 483 647 → `invalid`. The
  automatic next number uses stored alive sets and earlier numbered new sets, including a stored
  set deleted by this intent. A next number above the maximum is refused before storage.
- A set create that is not a command's (`gym.importSession` and `gym.correctSession` create sets in
  finished sessions):
  - an open session admits it;
  - a session with `finishedAt` set and `closedBy` other than `stale`, unset included →
    `session-finished`;
  - a session closed as `stale` admits it iff `completedAt ≤ finishedAt + 4 h`, and then sets
    `finishedAt := max(finishedAt, completedAt)`. Otherwise → `session-finished`.
- A set update or delete is admitted whatever its session's state, and moves no `finishedAt`: a
  lifter fixes and deletes sets of a finished workout.
- Only a command moves a standing set's `completedAt`: a delta that writes it → `invalid`.
- Every exercise reference (a set's `exerciseId`, a routine entry's `exerciseId`, a command's set)
  must be a seed or the owner's; otherwise `unknown-exercise`.

**Commands.** `gym.closeStale` (`beforePull`, §2.4) runs first inside `gym.start` and
`gym.importSession`, before every pull of an existing `self/gym`, and, when the open session has gone
stale, before the server reads that settle staleness ([gym ARCHITECTURE](../../backend/products/gym/ARCHITECTURE.md)
§4.2 lists them); a read with nothing stale admits nothing.
It is the only writer of `closedBy = stale`.

- **`gym.start {id: ref<session>, routineId?: ref<routine>, startedAt: time, joinOpenSession}`.**
  Clients send `joinOpenSession: true`.
  1. A start receipt for `id` (the session it created or joined) names a session; with none, the
     caller's own session under `id`, alive or dead, does → ok. While that session is alive, the
     write map carries it with its `born`, and `from: id` if it is a different session.
  2. An open session `o` exists: with `joinOpenSession` → ok, a receipt, and the write map
     `{session, o.id, from: id, born: o.born}`; otherwise → `session-open`.
  3. Otherwise create the session with a receipt, freezing `plan` from the routine and writing
     `historyRoutineId := routineId`. A routine the owner cannot read gives `plan = null` and
     `routineId = null`.

  Predicts the session `{id, born, startedAt, routineId}`, with `plan` composed from the drawn
  routine. A replay whose receipt names a dead session writes nothing; the predicted session stays
  drawn until its entry resolves (§7.5 step 2).
- **`gym.importSession {id: ref<session>, routineId?, startedAt: instant, finishedAt: instant, sets}`.**
  Creates a finished session (`closedBy = finish`) and its sets, with no join. `sets` holds at most
  200 sets, each `{id, exerciseId, weightKg, reps, kind?, rpe?, note?, completedAt}`, with a set's
  bounds and quanta. A set's `completedAt` is an integer epoch ms inside a `json` argument, not an
  `instant`, so §6.1 step 2 does not bound it: the command's check does (`bad-instant`).
  - An import receipt for `id`: equal raw arguments → ok, its session alive or dead; different →
    `payload-conflict`. The caller's own session under `id` that no import created →
    `payload-conflict`.
  - `foreign` → `id-taken`.
  - Two sets with one id → `invalid`.
  - `finishedAt < startedAt`, `finishedAt > serverNow`, or a set outside `[startedAt, finishedAt]`
    → `bad-instant`.
  - The interval crosses another finished session → `session-overlap`, with detail `{sessionId}`
    naming the earliest it crosses, a span being `[startedAt, max(finishedAt, startedAt + 1))`.
  - A routine the owner cannot read → `plan = null` and `routineId = null`.

  Sets are numbered in argument order. Predicts the session and its sets.
- **`gym.correctSession {sessionId: ref<session>, requestId, startedAt: instant, finishedAt: instant, routineName, sets, preserveOtherSets?}`.**
  Each set is `{id, exerciseId, setNumber, weightKg, reps, kind?, rpe?, note?, completedAt}`, with a set's
  bounds and quanta, its `completedAt` bounded by the command's check as `gym.importSession`'s is. `requestId` matches the gym id pattern, and `routineName` is ≤240 bytes or
  null. It corrects a finished workout; `preserveOtherSets` is an optional boolean, default false:
  - The session is alive and the owner's; otherwise `unknown-record` or `record-dead`.
  - The `requestId` was applied to it with equal arguments → ok; otherwise → `payload-conflict`.
  - Its `finishedAt` is unset → `session-open`.
  - 1–200 sets with unique ids; set numbers 1–2 147 483 647 and unique per movement; every instant within
    `[startedAt, finishedAt]` and not in the future → otherwise `bad-instant` or `invalid`.
  - Crossing another finished session → `session-overlap`.
  - An existing set whose `exerciseId` changes → `invalid`. A set keeps its kind; a new set takes
    `kind`, default `working`. Set numbers are taken as given, and a kept set takes its `completedAt`. Omitted `rpe`
    and `note` keep their values. Unnamed prior sets die unless `preserveOtherSets` is true, which
    leaves those rows unchanged. Their numbers must not collide with named sets, and their times
    must remain within the interval; the 200-set limit applies only to the argument. A reused or spent set id → `id-taken` or
    `id-spent`.
  - `startedAt`, `finishedAt`, `closedBy := finish`, and `displayName := routineName`.

  Predicts the session and its sets.
- **`gym.finish {sessionId: ref<session>, finishedAt: time}`.**
  - Absent or `foreign` → `unknown-record`; dead → `record-dead`.
  - `finishedAt < startedAt`, zero or out of range → `bad-instant`.
  - Unfinished → `finishedAt`, and `closedBy = finish`.
  - Closed `stale` at `f` → `closedBy = finish`, and `finishedAt := f` if `finishedAt > f + 4 h`,
    else `max(f, finishedAt)`.
  - Closed `finish`, or finished with `closedBy` unset → ok.

  Predicts `finishedAt` and `closedBy`.
- **`gym.applyProposal {proposalId: ref<proposal>}`.**
  - Absent or `foreign` → `unknown-record`; dead, having died with its routine → `record-dead`.
  - `applied` → ok.
  - `dismissed` → `proposal-settled` with detail `{state}`; `superseded` → `proposal-superseded`
    with detail `{reason}`; pending while `routine.revision ≠ baseRevision` →
    `proposal-superseded` with detail `{reason: routine-changed}`. The refusal changes no state;
    the proposal remains pending and `settledAt` is unchanged.
  - Otherwise `state = applied` and `settledAt := serverNow`, and the routine takes the proposal's
    document: `name := proposedName` and `entries :=` its changes but the removed ones, in order,
    each `{exerciseId, …after}`; a removal kills the routine.
  - `reason`: `replaced` when `supersededBy` is set; otherwise `routine-changed` when
    `routine.revision ≠ baseRevision`; otherwise `superseded`, a proposal superseded before gym
    recorded why (Appendix C).

  Predicts both.
- **`gym.dismissProposal {proposalId}`.** Absent or `foreign` → `unknown-record`; dead →
  `record-dead`. `dismissed` → ok; `applied` → `proposal-settled` `{state}`; `superseded` →
  `proposal-superseded` `{reason}`; otherwise `state = dismissed` and `settledAt := serverNow`, with
  no revision check. Predicts `state`.
- **`gym.closeStale`** (server-internal). An open session whose last activity (its last set's
  `completedAt`, else `startedAt`) is at least 4 h before `serverNow` gets
  `finishedAt := last activity` and `closedBy = stale`.

**Client stale rule.** In `drawn`, an unfinished session whose last activity is at least 4 h before
`physNow()` is drawn closed. `liveHint` is true while `drawn` holds an unfinished session that is not
stale. Logging after a stale close issues a new `gym.start`.

**Gestures:**
- **Held:** delete set, delete routine, discard session, delete note, delete weigh-in.
- **A reorder** writes the moved note's `ord`, or a routine's `position`.

**Projections outside synced fields:** note `position` is client-derived (R118 above); set revisions
(what a correction or a delete replaced). A session's death also deletes its workout share, which is outside the engine (§0).

**Server-origin doors.** MCP, the server Coach and the import door (`POST /v1/gym/sessions/import`)
admit as server origins (§6.3, D-23). [Gym ARCHITECTURE](../../backend/products/gym/ARCHITECTURE.md)
states how each builds its intents, what its builders read under the scope lock and answer without
admitting (a start whose clock is ahead, a start under a discarded session's id, a discard of an
unfinished session, a replayed create, a Coach note save the notes already hold), and how it
presents replies and translates refusals.

**Codes** (§9.6), the registry's `codes`: `payload-conflict` (`gym.importSession`,
`gym.correctSession`), `session-finished` (the set rules), `session-open` (`gym.start`,
`gym.correctSession`, a delete of an unfinished session), `session-overlap` (`gym.importSession`,
`gym.correctSession`), `unknown-exercise` (the set rules), `bad-instant` (the commands; a weigh-in's
future day), `proposal-settled` and `proposal-superseded` (`gym.applyProposal`,
`gym.dismissProposal`).

### A.3 Journal

**Scope:** `self/journal`. **Surfaces:** web, iOS.
**Adoption:** the existing page and revision tables, in place (Appendix D).
**Primary types** (§9.2): `page`. `journalState` never makes an account hold pages.

| Type | Identity | Life | Fields and rules |
|---|---|---|---|
| `page` | keyed (writer's local Gregorian day `YYYY-MM-DD`, years 0001–9999) | none; `visibleWhen: [body, mood, energy]` | server-written: `body` text ≤131 072 UTF-8 bytes; lww `mood`, `energy` integers 0–10 or null, `source` ∈ {typed, spoken}, `documentStamp` `{ms, counter, actor}` below. Written only by the two commands. A persisted blank row remains a REST resource and a feed row, though invisible to primary-record and canvas reads; there is no page delete. |
| `journalState` | singleton `journalState` | none | client-written ranked `placeholder`, `privacyLine`, `firstPage`, `scales`, each pending (rank 0) or retired (rank 1), default pending. They only retire; a lower-ranked write cannot bring an invitation back. Not primary. |

**Page checks.** `check` refuses a page write not generated by its commands with `invalid`, from
either origin. A day must actually exist in the Gregorian calendar, including century leap rules;
shape alone is insufficient. Body bytes are verbatim: no trim, NFC, title or markdown conversion.
U+0000 follows the engine's intent rule. Null means unanswered; zero is an answer. Engine arguments
are strict.

**Content stamp.** `documentStamp` is the full journal HLC as product data: unsigned safe `ms`,
unsigned 32-bit `counter` and 1–64 printable ASCII bytes of `actor`, with `{ms: 0, counter: 0,
actor: ""}` also allowed. Actors may contain `:`. Compare it lexicographically by ms, counter,
then actor, exactly as D-1; it is never an envelope stamp. Future content stamps are allowed. No
engine HLC, `hlcHigh`, `admittedHigh`, recovery or digest clock observes this value. The
native journal keeps a separate durable content clock, shared by its writers: observe the current
page's content stamp, take the maximum of it, that clock and the commit's `now`, and tick with the
writer's actor. Carry a counter overflow into ms; exhaustion of safe ms is a local save failure
that keeps the writing. Persist its new clock only with the successful local commit. Its content
stamp stays unchanged through transport retries, re-identification and envelope restamping.
The clock's pair is the registry's `device/journal` row `contentClock`, `localOnly`, committed
with the command. Its replica lifecycle is §7.10; it is distinct from the install's ink preference.

**`journal.savePage`** (`day`, `body`, `mood`, `energy`, `source`, `stamp`), both origins:
1. Validate the actual day and content stamp; invalid → `invalid`. A raw body over the text cap →
   `too-large`, before considering whether its stamp loses.
2. If a standing page has a content stamp ≥ `stamp`, answer `ok` with no writes: the whole stored
   page wins, including on a tie. No revision, receipt time or watcher changes.
3. Otherwise write all four document fields and `documentStamp` together. The lattice fields take
   one fresh server envelope stamp, and body is an internal replacement (§6.4), never diff3, with
   `archiveNonempty = true`. Even a scale-only save over nonempty body
   archives that body's head and gives the replacement a new rev. The replacement uses
   `archiveNonempty = true` and metadata holding the outgoing content stamp and `superseded_at`.
   The write map names the new
   lattice stamps. `apply` sets the legacy stamp columns to the content stamp and `updated_at` to
   server time, in the same transaction as the row and digest; those columns are projections, not
   additional lattice truth. After commit, notify the existing page watcher with the winning page
   exactly once per accepted save; a no-op announces nothing.

**`journal.claimPage`** (`day`, `body`, `mood`, `energy`, `source`, `claimId`), both origins:
1. Validate as for a save, with a nonempty `claimId` of at most 128 bytes. Its durable receipt is
   keyed `(scope, claimId)` and holds the raw arguments' digest and day. An equal call → `ok`, no
   writes; a different call under that id → `claim-conflict`. Receipts live for the scope's lifetime
   and are written in the admitting transaction, not a read cache.
2. Read the account's day under the scope lock. Let `account` be its body or `""`, `here` the
   anonymous body. If `account.trim()` is empty use `here`; else if `here.trim()` is empty use
   `account`; else if `here` contains `account.trim()` use `here`; else use
   `rtrim(account) + "\n\n" + ltrim(here)`. Here trim uses §6.11's ECMAScript whitespace set.
   This joins account prose first, then the device's, and avoids the contained-body duplicate.
3. An incoming null scale keeps the account's value, or null when absent; zero replaces it. Source
   is the incoming source. If the joined body exceeds the cap → `too-large`, with no receipt or
   partial state write. Mint a content stamp strictly above the account's stamp by the content
   clock rule, with actor `srv`; exhaustion → `invalid`. Replace and archive as save step 3, and
   store the receipt atomically. A retry after another device's edit never appends the claim twice.

**Anonymous writing and claim.** Anonymous autosaves queue full `claimPage` snapshots, one current
snapshot per day, with a CSPRNG `claimId` (at least 122 bits). The next autosave uses `supersede`
(§7.1) for the day's prior anonymous gestures, and carries the full current document and every
first-run retirement it keeps. Failed commits leave the prior snapshot queued. These commands do
not leave the device before binding. Sign-in follows §7.10: automatic Add only when the account
holds no primary pages; otherwise explicit Add or Discard. State-only entries do not make the
account occupied. An Add sends the retained claim commands, which join on the server; a Discard
discards their onboarding deltas too. Bound autosaves use `savePage` once that day's claim has been
reconciled; they do not supersede sent work. Binding alone MUST NOT switch a pending claimed day
to an ordinary stamped save: a save stamped at T+4 loses to a claim admitted at T+100, even when
both answer `ok`. Its empty write map preserves neither the newer text nor a revision.

The journal adapter commits a `localOnly` `device/journal` record keyed `pendingClaim:<claimId>`
with each anonymous claim. Its CSPRNG identity avoids collisions when §7.10 moves device rows;
anonymous supersession replaces that record atomically with the claim. It retains the frozen
claimed document, latest full editor document, touched fields and cumulative first-run retirements.
While that day's claim is pending, every edit durably updates this record before saying saved here;
it creates no `savePage` yet. The editor draws the latest retained document over the claim prediction,
including after restart. Pulls, an `ok`, sign-in and an in-memory dirty flag cannot erase it.
Sign-out Keep preserves pending claims, edits and retirements with that account's dormant work;
they resume only when the same account signs in. Discard deletes them. The journal's pending-work
hook counts each pending claim with touched fields or retained retirements as one additional
unsaved work item, including an invitation-only edit or a claim whose outbox entry already resolved.
Record the claim's successful result `(epoch, seq)` in the same local result transaction, before
the generic engine can resolve/remove its entry. Retain refused claims and edits with an unsaved
notice; never replace a pending claim with another claim that appends its text again.
Recoverable `clock-skew` and `base-unknown` refusals do not mark the pending record terminal;
their retries may still produce the successful result needed for reconciliation.

Reconcile only when that result and a complete, digest-checked joined page in the same epoch are
both durable: a live cursor without a partial-row key covers the result seq, with no boot staging,
behind flag or digest failure. Either arrival order is legal. In one local read-and-commit:

- Preserve the confirmed account prose and replace the frozen anonymous contribution with the
  latest edited contribution. If joined body equals the frozen body, use the latest body. Otherwise,
  when it ends with `"\n\n" + ltrim(frozenBody)` and that body is nonblank, retain the preceding
  account prefix and join the latest body using `claimPage` step 2. An emptied contribution keeps
  the account prefix. If a concurrent rewrite prevents identifying that suffix, join the complete
  confirmed body with the latest body by step 2, retaining both rather than guessing a deletion.
- Untouched scales/source use the confirmed values; touched fields use the latest values, including
  an explicit null that clears a scale. Retained first-run retirements accompany the save.
- Observe the confirmed `documentStamp` and durable content clock and mint a content stamp
  **strictly greater** than both using the commit's `now`. Enqueue the reconciled full `savePage`,
  persist the new clock, and remove the pending record in that same transaction. Its durable outbox
  now retains the edits. A failed commit or exhausted content clock leaves the pending record intact.

An epoch change invalidates the covering proof, not the retained writing. If the engine has already
resolved the claim entry, requeue its exact frozen arguments under the **same** claimId/receipt and
clear the old result atomically; otherwise let its existing entry recover through §7.5/§7.11.
Wait for the new result and covering pull before reconciliation. Receipt replay appends nothing.

With no intervening page edits, confirmation removes the pending record and displays the joined
row, committing any retained first-run retirements as a state delta in that same transaction.
With page edits, backed up requires the reconciled save's result and covering pull; the claim's
confirmation alone is insufficient. `journal/claim-edit.json` includes the T+4/T+100 loss as a
negative control and the required delayed-admission, restart and reordered-response outcomes.

**First run.** The UI follows [journal onboarding](../design/journal/onboarding.md) and
[the shell flow](../design/guidelines/superapp-flow.md). Mood and energy are visible on first open,
unasked. The privacy fact is "Only you. No prompts, no fields, nothing to fill in — write a line or
a page." Native first run writes today's page only; past days remain read-only, as on web.
A first keystroke retires `placeholder`; the first successful durable written-page commit retires
`privacyLine` and `firstPage`, atomically with the page command. `scales` retires on the first
answer or dismissal of its invitation, not just because the page was kept. The scale invitation
appears after `firstPage` is retired; the controls are available from first open. A saved zero
counts as an answer. The quiet Keep invitation
appears only after the scale invitation is answered or dismissed, one invitation at a time.
Signed-in pages never show Keep. State comes from the active replica's drawn row; a signed-in install
waits for the account's first complete pull before concluding that it has no pages or retired
copy. Appendix D retires all four first-run fields for accounts with written pages, so existing
writers see no re-onboarding. A failed read is never an empty account. Ink notes use an install
preference outside the engine, surviving sign-in and sign-out; they show once per install, when
the absence of written pages is known, and nothing shows them again. Geometry, keyboard, motion
and invitation timing are canon, not registry fields.

A page is written and visible when body is not `""`, or either scale is non-null; whitespace
counts on every surface. Such days sort oldest first, with today at the bottom and unwritten
gaps absent. A blank persisted REST resource remains in the replica but neither appears in the
canvas nor makes the account occupied. Local durability means saved here; backed up requires confirmation of the current page
command and its server row. Pending or offline writing must never be labelled backed up. Failed
or refused saves keep their text and state what is unsaved.

**Revisions.** Keep every outgoing nonempty body, including duplicate text at different head revs.
The revision table retains its outgoing content stamp and `superseded_at` as projection metadata.
Only an insertion prunes, in that same admission: first to the newest 10 for the changed day,
then to the newest prefix of at most 500 rows and 8 388 608 body bytes across the account, and
remove rows older than 90 days (`superseded_at < serverNow − 90 days`). Equal times order by the
stable retention ordinal of D.3, newest first. Saves over empty bodies, stale saves and pulls do
not prune. No sweep changes this table. Revision bytes exclude metadata; revisions never enter
the scope digest.

**Writers and reads.** Pages are written only through replicas; no server-origin door writes one.
The REST reads in [journal ARCHITECTURE](../../backend/products/journal/ARCHITECTURE.md) (a page,
a range, all pages, the HLC `since` cursor and export) read the same rows; that cursor is a REST
cursor, not an engine seq cursor. The revision table, legacy stamp/time projections and watcher are
written by `apply`, never by a second SQL page writer. A watcher failure cannot roll back an
admitted page; the repair sweep supplies the derived work. Sign-in asks Add/Discard before adding
signed-out pages to an account that already holds pages; an empty account adopts silently
(§7.10).

**Deferred features.** Echo spans, embeddings, pairs, curation, feedback and all their computation
stay in today's tables and REST; no first-run iOS screen consumes them. Page admission still
announces accepted page changes to their existing watcher. Nudge settings, delivery ledger and
mail sweeps stay on REST; the adaptive rhythm is a device computation, and native first run has
no nudge surface. Transcription stays REST and creates no page: later voice text saves with
`source = spoken`, without audio in the engine. Search and threads are device computations;
week/year/zoom are read models over pages; export stays its current REST door. None needs an
extra synced type for first run, and native exposes no placeholder control for a deferred feature.

**Codes:** `claim-conflict` (a different claim under the same receipt id); all other refusals use
the engine's codes.

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
| `LIVE_PING_MS` | 25 000: the client sends `ping` after this long with no frame or `pong` received |
| `LIVE_PONG_MS` | 10 000: a `ping` unanswered for this long fails the socket (§7.5) |
| `REQUEST_TIMEOUT_MS` | 60 000: a pull or push with no answer by then is a transport error |
| Re-pull backoff (§7.9) | base 1000 ms; ceiling 30 000 ms; full jitter; per scope; `k` resets after one unbroken stretch of 30 000 ms (on the monotonic clock) followed and not in doubt, checked when the stretch ends and at the ignored end that starts a doubt, when the scope leaves the subscription set, and at a sign-in, a sign-out or a re-identify of the active replica |
| `WRITER_SLICE_MS` | 25: how long, at most, an engine transaction other than a commit should hold the store's writer (§2.5, a latency intent) |
| `OFFSET_SAMPLES` | 8 |
| `CLOCK_JUMP_MS` | 1000 |
| `SCOPE_HORIZON` / `REPLICA_GC` / `REQUEST_RETENTION` | 30 / 365 / 90 days |
| `REQUEST_LEASE_MS` | 60 000 |
| Gym stale window | 4 h |

---

## Appendix C: Gym's adopted base

Gym's production rows were adopted in place: every account that held gym rows on 2026-10-04 has a
scope whose base the adoption wrote without admission, and every row change since is an admission.
C.1–C.6 define that base, C.7 the invariants that start from it, and C.8 the R118 metadata added to
it. No tool adopts a database again, so production is never restored from a backup taken before
the adoption. Journal's adopted base is Appendix D; every other product starts from empty stores.

**C.1 Adopted tables.**
- Each account that held a gym row, or an id C.3 spends, has one scope, `acct:<A>/gym`, alive, and
  a row in `gym_sync_adoptions`. A scope born by admission has none. The seed catalog, the
  `gym_exercises` rows whose `created_by` is null, is in no scope (A.2).
- The adopted tables:

  | Type | Rows |
  |---|---|
  | `routine` | `gym_routines`, its `entries` register held by `gym_routine_entries` and `gym_routine_entry_sets` |
  | `exercise` | `gym_exercises` the account created, its `aliases` in `gym_exercise_aliases` |
  | `exerciseName` | `gym_exercise_names`, a seed's `aliases` in `gym_exercise_aliases` |
  | `session` | `gym_sessions` |
  | `set` | `gym_sets` |
  | `note` | `gym_notes` |
  | `weighin` | `gym_bodyweight` |
  | `prefs` | `gym_preferences` |
  | `proposal` | `gym_proposals`, its `changes` register held by `gym_proposal_changes` |

- Every other gym table is outside the engine and keeps its writers: the receipts
  (`gym_write_receipts`, `gym_correction_receipts`, `gym_note_saves`), the projection
  `gym_set_revisions`, the shares (`gym_session_shares`, `gym_log_shares`, `gym_log_share_sessions`)
  and every Coach table (`gym_ask_*`). `gym_routine_creations` holds the read-only
  `routineCreation` records (C.8).
- Each adopted table carries the envelope of §2.2: `seq`, `rc`, `ru`, a stamp column per lattice
  field, and `born` and `life_stamp` where its type has life. Its scope is its `user_id`'s
  (`created_by`'s for `gym_exercises`), indexed by that column and `seq`. A register a type keeps in
  tables of its own (a routine's `entries`, a proposal's `changes`) keeps its one stamp on the
  record's row.
- No `ON DELETE` action writes a synced row: none links two adopted tables, or an adopted table's
  key to a table outside the engine, and admission writes each consequence (A.2). Actions that write
  only tables outside the engine (a session's shares and set revisions), or the rows of a dead
  record's own register, remain; so does `user_id`'s, since account deletion purges every scope the
  account owns (§2.3 `purge`).
- No trigger writes a synced column: the commands that create a session write `historyRoutineId`
  (A.2).

**C.2 Stamps and registers.**
- The adoption read the server clock once, as it started: `M`, recorded per account in
  `gym_sync_adoptions.migration_ms`. Every born, life and field register it wrote carries the stamp
  `M:0:srv` until an admission replaces it.
- A record's registers are its non-null columns, as the fields A.2 names them (`date_local` is a
  weigh-in's id, `set_number` a set's serial value), instants as epoch ms and `numeric` values as
  numbers. The R118 metadata is C.8's, not the base's. Beyond the columns of the same name:
  - a routine's `entries`: its lines in `position` order, each `{exerciseId, restSeconds?, sets?}`,
    with `sets` from its set rows in `set_index` order when it has any, each `{reps?, weightKg?}`;
  - a proposal's `changes`: its rows in `position` order, each `{kind, exerciseId, before?,
    after?}` (A.2), a side `{sets?, restSeconds?}` of its non-null columns;
  - `aliases`: the account's alias names of the movement, newest first (`created_at` descending,
    then name);
  - an `exerciseName` for every seed the account renamed or holds aliases of: `name` from its
    `gym_exercise_names` row when it has one, and its aliases.
- A minted record is alive with `born = life = M:0:srv`; a weigh-in is alive at that stamp.
- A value outside its field's domain (a row older than a bound) stands as it was adopted: domains
  bind at admission (§6.1 step 2), and a later write of the record meets them.

**C.3 Spent ids.** `sync_spent` holds, with born and life stamp `M:0:srv`, each of these ids that no
standing row of its type held at adoption:
- a set's, from a `gym_set_revisions` row marked deleted or a set receipt of `gym_write_receipts`;
- a session's, from a session receipt of `gym_write_receipts`;
- a routine's, from `gym_routine_creations`;
- a note's, from `gym_note_saves`.

**C.4 Order.** The adopted notes, in `(position, id)` order, hold the `ord` keys `between(null,
null)`, then each `between(previous, null)` (D-25), so a note's dense rank was its `position`.
Routines keep theirs.

**C.5 Receipts and projections.**
- The command receipts are gym's own tables. A session receipt of `gym_write_receipts` names the
  session created under its id: it is `gym.start`'s receipt `id → session_id`, and, when an import
  created the session, `gym.importSession`'s. The rows of `gym_correction_receipts` are
  `gym.correctSession`'s. A receipt holds a request hash, and a replay compares its call by that
  hash, the digest of the raw arguments gym computes (§6.4).
- Stored metadata keeps its columns, and C.8 binds the R118 registers to them: a routine's
  `revision`, `created_entries` and `created_at`, `gym_routine_creations`, a proposal's
  `base_revision`, `base_name`, `changes` and `created_at`, a note's `position` and `updated_at`,
  and `gym_set_revisions`.

**C.6 Seq, receipt times, counters and digest.**
- `seq`: the base runs 1, 2, … in one pass over the scope's records and spent ids, in the
  registry's type order, which places each type after the types its references name, then by id;
  its `scope.seq` was the last.
- An adopted row's `rc` is its `created_at`, else its `updated_at`, else `M`; its `ru` is its
  `updated_at`, else `M`, until an admission changes the row.
- `counters.note` started as the count of the adopted notes.
- The base digest is the sum over the adopted alive rows as `feed` returns them (§6.12).

**C.7 Invariants of an adopted scope.** §5's proofs start from empty stores. For an adopted scope
the base case is the state the adoption left, and the inductive steps are unchanged: every row
change since is an admission, except C.8's supplement.
- **INV-14.** Base: every stamp the adoption stored is `M:0:srv`, `M` being the server clock's
  reading as it started. That clock never steps back within a process (§10.2), so each stamp was
  stored when `serverNow ≥ M`, inside the bound. Step: admission stores a client stamp only within
  the bound (§6.1 step 2), and mints a server stamp one tick after observing the stored stamps it
  overwrites (§10.3), which the base and the earlier steps bound. No replica predates the adoption,
  so recovery terminates as from empty stores.
- **INV-15.** Base: the adoption set each scope's digest to the sum over its alive rows as `feed`
  returns them, in the transaction that wrote them, while no other writer ran. Step: every later row
  change is an admission, which moves the digest (§6.12). So the digest at every committed seq is
  the sum over the scope's alive rows, and the rest of the proof holds as written.
- **INV-2.** The adoption made nothing dead but C.3's spent ids, which stay spent. A record deleted
  before the adoption that C.3 does not name was never made dead by an admitted delete, so INV-2
  does not speak of it: a create may bring its id back.
- **INV-3, INV-6, INV-10 and INV-16.** No replica predates the adoption, so each holds from a
  replica's first pull, as from empty stores.
- **INV-5.** The adoption assigned seqs in one ascending pass, and admission takes the next from
  `scope.seq` (§6.1 step 13).
- **INV-8.** The note counter started as the alive count, and no account held more than ten notes:
  a note's `position` was 0–9 and unique per account.
- **INV-11.** Partial unique indexes held A.2's invariants before the adoption (one open session per
  account; one pending proposal per routine, door and connection), and the adoption changed
  neither.

**C.8 R118 metadata.** A.2's six scalar registers and the `routineCreation` records were added to
the adopted rows by one supplement, which replayed no write. It read the server clock once as
`M118`, recorded in `gym_sync_metadata_upgrade_runs`; each account's completion is a row of
`gym_sync_metadata_upgrades`. A scope born by admission after the adoption took the same supplement.

| Register | Source, copied verbatim |
|---|---|
| `routine.revision` | `gym_routines.revision` |
| `routine.createdEntries` | `gym_routines.created_entries`; SQL NULL stays absent |
| `proposal.baseRevision`, `baseName`, `changeCount` | `gym_proposals.base_revision`, `base_name`, integer `changes`; never recomputed from the current routine or diff rows |
| `note.updatedAt` | `gym_notes.updated_at` as epoch ms |
| `routineCreation.snapshot` | the decoded `gym_routine_creations.routine` JSON, owned by `user_id`, keyed by `routine_id`, including deleted routines |

- A missing original count or snapshot stays missing: no creation count comes from live entries, no
  frozen base from the current routine, no historical JSON is normalized and no note content time
  is migration time. Historical out-of-domain values stand as C.2 says.
- Every new present register carries `M118:0:srv`; an absent count has no stamp. Every older
  register, born, life, `rc`, `ru`, spent row, receipt, set revision, note position and `ord`, and
  counter kept its value. `changeCount` maps to the integer `changes` column, and the `changes`
  lattice to `gym_proposal_changes` with its own `changes_stamp`. `routineCreation` binds
  `gym_routine_creations` directly, with `seq`, `rc`, `ru`, `snapshot_stamp` and the index
  `(user_id, seq)`; its value stays in `routine`, with no born, life or routine foreign key.
- A snapshot row's `rc = ru = M118` is administrative and MUST NOT be rendered as a historical
  creation date (A.2).
- Each changed routine, snapshot, note and proposal took one fresh seq above its scope's high seq,
  in v5 registry type order, then id byte order, and the scope's digest and high seq moved in the
  same transaction; the adopted prefix keeps its seqs. A live cursor received the supplement through
  ordinary pulls, with no epoch change.

---

## Appendix D: Journal's adopted base

Journal's production tables were adopted in place: every account kept its pages, legacy content
stamps, server receipt times and retained invisible revisions, and no page was copied to an engine
shadow table. This is the journal exception to the empty-stores premise, beside gym's Appendix C.
D.1–D.6 define the base, and D.7 the invariants that start from it.

**D.1 Adoption and envelope.**
- Each account that held `journal_page` or `journal_page_revision` rows has one alive scope,
  `acct:<A>/journal`, and a row in `journal_sync_adoptions`. Any other account gets its scope at its
  first admission.
- `page` is `journal_page`, keyed by its `(user_id, day)`. It carries `seq`, `rc`, `ru`,
  `mood_stamp`, `energy_stamp`, `source_stamp`, `document_stamp_stamp`, `body_rev` and
  `body_merged`; the scope is taken from `user_id`, with index `(user_id, seq)` (§2.2). There is no
  born, life or spent-id column. `body`, mood, energy and source remain the typed truth. The value
  of `documentStamp` is the three HLC columns, not their envelope stamp.
- `journalState` uses one companion table `journal_sync_state`, keyed by `user_id`, with its four
  ranked values and their stamps, `seq`, `rc`, `ru`, and index `(user_id, seq)`. It is not a second
  page store and exposes no REST resource.
- `journal_page_revision` is the revision table. Each row retained at adoption holds an immutable
  `migration_id`, its ordinal in the original `ctid` order within the account, and every row holds
  `engine_rev`; uniqueness is `(user_id, engine_rev)`. Body, outgoing HLC and `superseded_at` are
  kept; no revision becomes a visible record or enters the digest.
- The adoption marker holds the account, the adoption's `M`, the first-run policy D.4 names and the
  manifest digest. The native claim receipt table `journal_claim_receipts` holds `(user_id,
  claim_id, arguments_digest, day)` for A.3's `claimPage` and lives for the scope's lifetime. Both
  tables are outside `feed`.
- Account deletion purges every account scope, revisions, state and claim receipts (§2.3). There is
  no page-to-page foreign-key consequence or trigger. A schema statement, trigger or repair job
  MUST NOT write a page's value or envelope outside admission. Echo and nudge tables keep their own
  writers.

**D.2 Stamps, values and receipt times.**
- The adoption read the server clock once, as it started: `M`, recorded in its marker. Every
  envelope register of every adopted page and derived state row carries `M:0:srv` until an
  admission replaces it. No legacy content HLC was observed into the server clock: a page carrying
  a future `stamp_ms`, or `0:0:`, keeps that value without weakening INV-14.
- Body is unchanged UTF-8 text. Mood and energy took the read normalization: null or outside 0–10
  reads null; source reads spoken only when stored spoken, otherwise typed. A historical body
  beyond the admission cap stands as it was adopted; the next save is checked by A.3.
- An adopted page's `rc = ru = updated_at` as integer epoch ms, since this table has no creation
  time, and its legacy `updated_at` keeps its database precision for REST's epoch projection. A
  derived state row has `rc = ru = M`. No stamp is derived from those receipt times.

**D.3 Adopted revisions and the engine text field.**
- Revisions 1, 2, … are reserved for the retained audit rows, in ascending `migration_id` order
  across the account, including duplicate bodies. Each maps to `(page, day, body, engine_rev,
  text)` and retains its outgoing content stamp and archive time. These are synthetic engine
  revisions, not content stamps. Their ordinal keeps the original `ctid` tie-break across days as
  well as within a day.
- After that reserved prefix, the adopted pages are numbered in ascending day order; each body's
  head has `rev = page.seq` and `merged = false`, and is exactly the body it had, including empty
  text. A derived `journalState` row is numbered last. Every historical rev is below every adopted
  head, and no later head can collide with a historical rev. A revisions-only account keeps the
  reserved high seq even if no visible row stands there.
- A.3's revision pruning orders equal `superseded_at` by rev descending, which keeps the original
  tuple order; new head revs exceed the entire reserved prefix. Nothing relies on physical `ctid`.
- Admission writes body heads and audit revisions in this same table, keeping the old HLC and time
  metadata beside the unique engine rev.

**D.4 First-run state derivation.** `firstRunPolicy = retire-existing`, recorded in each adoption
marker. An account that had at least one written page (body not `""`, or a non-null normalized
scale) has `journalState` with `placeholder`, `privacyLine`, `firstPage` and `scales` retired, so a
person with written pages sees no re-onboarding. Retirement is not an inference of whether an
invitation was answered. An account with only blank resources or only revisions has no state row;
all defaults read pending. An install's ink-notes flag is outside the account data.

**D.5 Outside the engine.** Every `journal_span`, `journal_echo`, dismissal, offer dismissal, signal
and `journal_page_curation` row; every nudge setting, delivery decision, mail secret and
provider-suppression value; and their REST routes stay outside the engine. The legacy body, stamp
and updated-at projections keep their meaning for echo repair, search invalidation and the device's
nudge rhythm. Transcription persists no page or audio. The archive times and legacy metadata are
projections, not engine records.

**D.6 Scope, seq and digest.**
- An adopted `scope.seq` started as the last seq D.3 allocated, including its reserved historical
  revision prefix. No primary record exists for an account with only revisions. Counters and
  `sync_spent` stay empty: journal has no cap or life.
- The base digest is the sum over the exact `feed` rows, including `journalState` when derived
  (§6.12). Historic revisions, claim receipts, the adoption marker and REST-only projections are
  outside it.

**D.7 Invariants of an adopted journal scope.**
- **INV-14.** Base: every envelope stamp is `M:0:srv`, stored when the monotone process clock was at
  least M. Historic HLCs remain content values, never inputs to the engine HLC. Step: every admitted
  envelope stamp follows §6.1/§10.3. No replica predates the adoption, so clock-skew recovery
  terminates as in §5.
- **INV-15.** Base: D.6's digest was stored in the adopting transaction, while no other writer ran.
  Revisions and REST projections are outside the sum. Step: every later change of a page or state
  row is an admission and moves that sum in the same transaction. Deferred workers change no feed
  row; a watcher announces only after commit.
- **INV-2.** Journal pages and state have no life and no delete, so the adoption created no death or
  spent id and terminality is vacuous. Account deletion purges the whole scope. A body cleared by a
  newer save remains a resource; it never becomes an admitted death.
- **INV-5.** Historical revs reserve a prefix, then rows took one increasing pass. Admission
  allocates above the high seq and cannot reuse an old rev. A revisions-only scope has a seq gap,
  but its null-cursor boot still reaches the head with the empty-row digest.
- **INV-8/INV-11.** There is no journal counter; the unique `(user_id, day)` constraint keeps one
  page per day. A claim's unique receipt and raw-arguments digest prevent duplicate additions.
- **INV-3/6/10/16.** No engine replica predates the adoption. Each starts from its first complete
  pull, while the ranked state joins monotonically and the anonymous claim follows the lineage
  decision and durable outbox rules.
