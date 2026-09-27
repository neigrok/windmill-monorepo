#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Registry.h"
#include "platform/domain/sync/Scope.h"

#include <json/json.h>

#include <cstdint>
#include <exception>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm::sync {

// write: READ COMMITTED with the engine's lock_timeout. snapshot: one REPEATABLE READ READ ONLY view,
// which takes no row locks (§6.7).
enum class TxnMode { write, snapshot };

// One transaction of the engine's store. Destroying it without commit() rolls it back.
class SyncTxn {
public:
  virtual ~SyncTxn() = default;
  virtual void commit() = 0;
};

// §6.1 step 3's row modes: a tree held while an overlay writes (keyShare), a tree a command reads (share),
// the intent's scope (noKeyUpdate), a dying tree and its overlays (update).
enum class RowLock { none, keyShare, share, noKeyUpdate, update };

// §6.6: a transient failure is retried with nothing recorded; a fault is counted toward poison.
enum class FaultClass { transient, fault };

// §2.1 sync_scopes. `open` mirrors whether the tree's opening field holds an opening value (D-4).
struct ScopeRow {
  ScopeKey key;
  UserId owner;
  std::optional<std::string> governedBy;
  bool dead = false;
  std::optional<Ms> deadAt;
  Seq seq = 0;
  std::map<std::string, std::int64_t> counters;
  Digest256 digest;
  bool open = false;

  ScopeFacts facts() const { return ScopeFacts{owner, dead, open}; }
};

// §6.1 step 3.3 and §6.2 step 4: where a replica's intent n stands against the replica's row.
enum class Turn {
  foreign,   // the row is bound to another account: 409 replica-foreign
  answered,  // n ≤ last_n: answered from sync_results
  next,      // n = last_n + 1: admitted
  gap,       // n > last_n + 1: 409 gap
};

// §2.1 sync_replicas.
struct ReplicaRow {
  std::string replica;
  UserId account;
  std::uint64_t lastN = 0;

  // Read under the row's lock: the account first, then n against last_n.
  Turn turnOf(const UserId& origin, std::uint64_t n) const {
    if (account != origin) return Turn::foreign;
    if (n <= lastN) return Turn::answered;
    return n == lastN + 1 ? Turn::next : Turn::gap;
  }
};

// §2.1 sync_results: the stored result JSON, or none while the row only tallies faults (§6.6).
struct StoredResult {
  std::uint64_t n = 0;
  Digest256 digest;
  std::optional<Json::Value> result;
  int faults = 0;
};

// §2.1 sync_requests: a server-origin call (§6.3), or one of its admits under `<requestId>#<k>`.
struct RequestRow {
  std::string requestId;
  Digest256 digest;
  bool running = false;
  std::optional<Json::Value> result;
  Ms startedAt = 0;
};

// §2.3's keyset over one type's rows of one scope, in (seq, id) order: the rows strictly after
// (afterSeq, afterKey), `afterKey` compared as UTF-8 bytes of an id's JCS ("" is before every id).
struct FeedQuery {
  Seq afterSeq = 0;
  std::string afterKey;
  std::optional<Seq> throughSeq;  // a boot: seq ≤ asOf
  bool aliveOnly = false;         // a row with no life, or an alive one (§6.7 step 3's boot rule)
  bool visibleOnly = false;       // §7.6 visible(r), the §9.2 existence query
  std::size_t limit = 0;          // 0: every row
};

// The engine's own tables (§2.1): scopes, replicas and results, spent ids, requests and the epoch, plus
// the advisory locks of §6.1 step 3. A product never reaches them but through the engine.
class SyncStore {
public:
  virtual ~SyncStore() = default;

  virtual std::unique_ptr<SyncTxn> begin(TxnMode mode) = 0;
  virtual FaultClass classify(const std::exception& error) const = 0;
  virtual std::string epoch(SyncTxn&) = 0;
  virtual std::string ownerName(SyncTxn&, const UserId& owner) = 0;

  // An absent scope inserted alive at seq 0 with digest 0, answering true; an existing one untouched.
  virtual bool insertScope(SyncTxn&, const ScopeKey& key, const UserId& owner, const std::optional<std::string>& governedBy) = 0;
  virtual std::optional<ScopeRow> scope(SyncTxn&, const ScopeKey& key, RowLock lock) = 0;
  // Step 13: seq, counters, digest and open.
  virtual void saveScope(SyncTxn&, const ScopeRow& row) = 0;
  // Step 15: tree:<T> FOR UPDATE, then each overlay it governs FOR UPDATE in ascending key order, all
  // marked dead at `now`. Answers every killed key, ascending.
  virtual std::vector<ScopeKey> killTree(SyncTxn&, const ScopeKey& tree, Ms now) = 0;

  // §6.2 step 3 and §6.1 step 3.3: the replica's row, inserted with last_n 0 when absent; FOR UPDATE either way.
  virtual ReplicaRow bindReplica(SyncTxn&, const std::string& replica, const UserId& account, Ms now) = 0;
  // The replica's row in `lock`'s mode: none, or update (FOR UPDATE).
  virtual std::optional<ReplicaRow> replica(SyncTxn&, const std::string& replica, RowLock lock) = 0;
  // §6.2 step 3: a binding a push inserted and answers 409 on, deleted while its last_n is 0 and it holds no
  // sync_results row. The caller holds the replica row's lock.
  virtual void unbindUnused(SyncTxn&, const std::string& replica) = 0;
  virtual void setLastN(SyncTxn&, const std::string& replica, std::uint64_t n) = 0;
  virtual std::optional<StoredResult> storedResult(SyncTxn&, const std::string& replica, std::uint64_t n) = 0;
  virtual void putResult(SyncTxn&, const std::string& replica, const StoredResult& result) = 0;
  virtual void pruneResults(SyncTxn&, const std::string& replica, std::uint64_t through) = 0;

  // sync_spent: this scope's spent ids of a type among `ids` (as thin dead rows, by id key); which of them
  // another scope holds spent (a global id space); a death and a keyed revival; and the feed.
  virtual std::map<std::string, Row> spentIn(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) = 0;
  virtual std::set<std::string> spentElsewhere(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const std::vector<RecordId>& ids) = 0;
  virtual void addSpent(SyncTxn&, const ScopeKey& scope, const Row& thin) = 0;
  virtual void removeSpent(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const RecordId& id) = 0;
  virtual std::vector<Row> feedSpent(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) = 0;
  virtual std::uint64_t countSpent(SyncTxn&, const ScopeKey& scope, const TypeDef& type, const FeedQuery& query) = 0;

  // §6.1 step 3.6: fresh global ids by (type, id), in the ascending order given.
  virtual void lockIds(SyncTxn&, const std::vector<std::pair<std::string, std::string>>& typeIds) = 0;
  // §6.1 step 3.3 and §6.3: one call of an account's requestId at a time.
  virtual void lockRequest(SyncTxn&, const UserId& account, const std::string& requestId) = 0;
  virtual std::optional<RequestRow> request(SyncTxn&, const UserId& account, const std::string& requestId) = 0;
  virtual void putRequest(SyncTxn&, const UserId& account, const RequestRow& row) = 0;
};

}
