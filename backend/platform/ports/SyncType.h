#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Admit.h"
#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Registry.h"
#include "platform/domain/sync/Scope.h"
#include "platform/domain/sync/Wire.h"
#include "platform/ports/SyncStore.h"

#include <json/json.h>

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

// §2.3: what a product binds for each registry type and command. Storage and rules are separate ports, so
// one set of product rules and commands runs over Postgres and over the test fakes alike.

namespace wm::sync {

// One type's typed rows (§2.2). Every method works inside the engine's transaction.
class TypeStore {
public:
  virtual ~TypeStore() = default;

  virtual const TypeDef& def() const = 0;
  // Step 5: this scope's typed rows among `ids`, FOR UPDATE, by id key.
  virtual std::map<std::string, Row> lock(SyncTxn&, const ScopeKey& scope, const std::vector<RecordId>& ids) = 0;
  // A global id space: which of `ids` a typed row of another scope holds.
  virtual std::set<std::string> elsewhere(SyncTxn&, const ScopeKey& scope, const std::vector<RecordId>& ids) = 0;
  // Step 13: each row exactly as given (a missing `after` deletes it), and the superseded text heads the
  // product keeps. feed(apply(x)) == x under JCS, so the digest hashes the form a page carries (§6.12).
  virtual void apply(SyncTxn&, const ScopeKey& scope, const std::vector<RowWrite>& writes) = 0;
  // The rows of `query`, exactly as apply stored them, in (seq, id) order.
  virtual std::vector<Row> feed(SyncTxn&, const ScopeKey& scope, const FeedQuery& query) = 0;
  virtual std::uint64_t count(SyncTxn&, const ScopeKey& scope, const FeedQuery& query) = 0;
  // Step 11: the highest `field` among the alive rows whose fields hold `match`.
  virtual std::optional<std::int64_t> maxSerial(SyncTxn&, const ScopeKey& scope, const std::string& field,
                                                const std::map<std::string, Json::Value>& match) = 0;
  // §6.11 step 1: a superseded head the product still keeps.
  virtual std::optional<std::string> revisionText(SyncTxn&, const ScopeKey& scope, const RecordId& id, const std::string& field, Seq rev) = 0;
  // G5 and account erasure: every row and revision of the scope.
  virtual void purge(SyncTxn&, const ScopeKey& scope) = 0;
};

// Every cross-record read a product's check or command makes, inside the admitting transaction and under
// the intent scope's lock. What it locks joins the intent's locked set.
class SyncReader {
public:
  virtual ~SyncReader() = default;

  // A record of the intent's scope, locked as step 5 locks it, with its id state (§4.2).
  virtual const Locked& lock(const std::string& type, const RecordId& id) = 0;
  // The intent scope's rows of a type.
  virtual std::vector<Row> scan(const std::string& type, const FeedQuery& query = {}) = 0;
  // Another scope's row: a tree a command argument names, as step 3.5 locked it.
  virtual std::optional<ScopeRow> scope(const ScopeKey& key) = 0;
  virtual std::vector<Row> scanScope(const ScopeKey& key, const std::string& type, const FeedQuery& query = {}) = 0;
};

// Who admits the intent, as a product's rules and commands see it.
struct Caller {
  UserId account;
  bool server = false;
};

struct CheckCtx {
  const Registry& registry;
  const ScopeRow& scope;
  const Caller& caller;
  Ms serverNow = 0;
  SyncReader& read;
  SyncTxn& txn;
  const Intent& intent;
};

// A type's product rules (Appendix A).
class TypeRules {
public:
  virtual ~TypeRules() = default;
  // §6.1 step 10, on the joined records of the whole intent (every type): throws Refusal, or answers the
  // server deltas it appends to the intent's scope, their stamps unset for step 9's next pass.
  virtual std::vector<Delta> check(const CheckCtx& ctx, const std::vector<Change>& changes) = 0;
};

struct CommandCtx {
  const Registry& registry;
  const ScopeRow& scope;
  const Caller& caller;
  Ms serverNow = 0;
  const Json::Value& args;
  SyncReader& read;
  SyncTxn& txn;
  const Json::Value& rawArgs;
};

// Deltas a command writes into a scope the same intent creates (§6.1 step 14).
struct IntoScope {
  ScopeKey scope;
  std::vector<Delta> deltas;
};

// §6.4: the deltas a command writes into the intent's scope (stamps unset where step 9 mints), its writes
// into a scope it creates, its write map (D-20) and its detail (null for none).
struct CommandOutcome {
  std::vector<Delta> deltas;
  std::vector<IntoScope> into;
  std::vector<WriteEntry> write;
  Json::Value detail;
};

class SyncCommand {
public:
  virtual ~SyncCommand() = default;
  // §6.1 step 7: whether the call replays one admitted before, by the receipt it stored; a replay skips
  // the intent's guards.
  virtual bool isReplay(CommandCtx& ctx) = 0;
  // Step 8: deterministic given the locked rows, the arguments and serverNow. Throws Refusal.
  virtual CommandOutcome run(CommandCtx& ctx) = 0;
};

}
