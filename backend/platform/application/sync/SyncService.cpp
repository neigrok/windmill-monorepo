#include "platform/application/sync/SyncService.h"

#include "platform/application/WriteObservation.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Registry.h"
#include "platform/domain/sync/Scope.h"
#include "platform/domain/sync/Wire.h"

#include <algorithm>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <variant>
#include <vector>

namespace wm::sync {

namespace {

// The rows one read of a feed stream takes from the store.
constexpr std::size_t kFeedBatch = 256;

std::string epochOf(SyncStore& store) {
  const std::unique_ptr<SyncTxn> txn = store.begin(TxnMode::snapshot);
  return store.epoch(*txn);
}

// D-3: `rp_` and 32 lowercase hex characters.
bool isReplicaId(const Json::Value& replica) {
  if (!replica.isString()) return false;
  const std::string id = replica.asString();
  return id.size() == 35 && id.starts_with("rp_") &&
         std::all_of(id.begin() + 3, id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

// The body as JSON, or none when it is not strict JSON (§9.1 step 4).
std::optional<Json::Value> parsed(std::string_view body) {
  try {
    return parseJson(body);
  } catch (const JsonError&) {
    return std::nullopt;
  }
}

// A §9.1 safe integer of at least `least`.
bool isSafeAtLeast(const Json::Value& value, std::uint64_t least) {
  return isSafeInteger(value) && value.asDouble() >= static_cast<double>(least);
}

// §6.2 step 1's shape: exactly {replica: a D-3 replica id, account: a string, ackThrough: a safe integer ≥ 0,
// intents: [{n: a safe integer ≥ 1, …}]}.
bool isPushRequest(const Json::Value& request) {
  if (!request.isObject() || request.size() != 4 || !request["account"].isString()) return false;
  if (!isReplicaId(request["replica"]) || !isSafeAtLeast(request["ackThrough"], 0) || !request["intents"].isArray()) return false;
  return std::all_of(request["intents"].begin(), request["intents"].end(),
                     [](const Json::Value& intent) { return intent.isObject() && isSafeAtLeast(intent["n"], 1); });
}

// §9.4 PullRequest: exactly {scopes: [exactly {scope: string, cursor: string | null}]}.
bool isPullRequest(const Json::Value& request) {
  if (!request.isObject() || request.size() != 1 || !request["scopes"].isArray()) return false;
  return std::all_of(request["scopes"].begin(), request["scopes"].end(), [](const Json::Value& wanted) {
    return wanted.isObject() && wanted.size() == 2 && wanted["scope"].isString() && wanted.isMember("cursor") &&
           (wanted["cursor"].isString() || wanted["cursor"].isNull());
  });
}

// §9.3 Result: a stored or admitted result under its n.
Json::Value numbered(std::uint64_t n, Json::Value result) {
  result["n"] = Json::UInt64(n);
  return result;
}

Json::Value retryAt(std::uint64_t n, std::uint64_t afterMs) {
  Json::Value retry(Json::objectValue);
  retry["n"] = Json::UInt64(n);
  retry["retryAfterMs"] = Json::UInt64(afterMs);
  return retry;
}

std::optional<ScopeFacts> factsOf(const std::optional<ScopeRow>& row) {
  return row ? std::optional(row->facts()) : std::nullopt;
}

// §6.2 steps 3–6 for one well-formed push served as `account`: bind the replica, answer its intents in ascending n,
// prune what it acknowledged. Each step is a short transaction of its own, and none is open across an admission.
class ReplicaPush {
public:
  ReplicaPush(const SyncCatalog& catalog, SyncStore& store, Admission& admission, UserId account, const Json::Value& request, Ms serverNow)
      : catalog_(catalog), store_(store), admission_(admission), account_(std::move(account)), request_(request), replica_(request["replica"].asString()),
        serverNow_(serverNow) {}

  SyncReply run(PushBudget& budget, Json::Value body) {
    if (request_["account"].asString() != account_.str()) return SyncReply::refused(409, std::move(body), "account-mismatch");
    const Binding binding = bind();
    if (binding == Binding::unavailable) return SyncReply::unavailable(std::move(body));
    if (binding == Binding::foreign) return SyncReply::refused(409, std::move(body), "replica-foreign");
    Json::Value results(Json::arrayValue);
    std::optional<Json::Value> retry;
    std::size_t admitted = 0;
    for (const Json::Value* intent : byN()) {
      const std::uint64_t n = (*intent)["n"].asUInt64();
      const Digest256 digest = intentDigest(*intent);
      const std::optional<Turn> read = turnOf(n);
      if (!read) {
        retry = retryAt(n, Retry::kTransientMs);
        break;
      }
      Turn turn = *read;
      if (turn == Turn::next) {
        if (budget.spent(admitted)) {
          retry = retryAt(n, 0);
          break;
        }
        const AdmitOutcome outcome = admission_.admit(ReplicaOrigin{account_, replica_, n, digest}, *intent, serverNow_);
        if (const Retry* wait = std::get_if<Retry>(&outcome)) {
          retry = retryAt(n, wait->afterMs);
          break;
        }
        if (const Admitted* answer = std::get_if<Admitted>(&outcome)) {
          ++admitted;
          results.append(numbered(n, answer->result));
          continue;
        }
        // An overlapping push reached the replica's lock first.
        turn = std::get<OutOfTurn>(outcome).turn;
      }
      if (turn == Turn::foreign) return conflict(std::move(body), "replica-foreign");
      if (turn == Turn::gap) return conflict(std::move(body), "gap");
      const std::optional<Json::Value> stored = storedAnswer(n, digest, *intent);
      if (!stored) return conflict(std::move(body), "replica-forked");
      results.append(numbered(n, *stored));
    }
    body["lastN"] = Json::UInt64(prune());
    body["results"] = std::move(results);
    if (retry) body["retry"] = *retry;
    return SyncReply{200, std::move(body)};
  }

private:
  enum class Binding { bound, foreign, unavailable };

  // Step 3, once the push names the account it is served as: an absent binding is inserted at last_n 0, bound to that
  // account; a replica bound to another account is foreign. A transient failure comes before the push takes its
  // first intent, so the push answers it 503 (§6.6).
  Binding bind() {
    try {
      const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::write);
      const bool absent = !store_.replica(*txn, replica_, RowLock::update);
      const ReplicaRow binding = store_.bindReplica(*txn, replica_, account_, serverNow_);
      if (binding.account != account_) return Binding::foreign;
      txn->commit();
      inserted_ = absent;
      return Binding::bound;
    } catch (const std::exception& error) {
      if (store_.classify(error) == FaultClass::transient) return Binding::unavailable;
      throw;
    }
  }

  // Step 4's comparison of n with last_n as read under the replica row's lock, never a value read earlier. A
  // binding an overlapping push's 409 took away reads as this account's at last_n 0: the admission inserts it
  // again (§6.1 step 3.3). None when the read failed transiently: the push answers the results so far (§6.6).
  std::optional<Turn> turnOf(std::uint64_t n) {
    try {
      const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::write);
      const std::optional<ReplicaRow> row = store_.replica(*txn, replica_, RowLock::update);
      return row.value_or(ReplicaRow{replica_, account_, 0}).turnOf(account_, n);
    } catch (const std::exception& error) {
      if (store_.classify(error) == FaultClass::transient) return std::nullopt;
      throw;
    }
  }

  // Step 4 takes the intents in ascending n, equal n's in the order the request carried them.
  std::vector<const Json::Value*> byN() const {
    std::vector<const Json::Value*> intents;
    for (const Json::Value& intent : request_["intents"]) intents.push_back(&intent);
    std::stable_sort(intents.begin(), intents.end(),
                     [](const Json::Value* a, const Json::Value* b) { return (*a)["n"].asUInt64() < (*b)["n"].asUInt64(); });
    return intents;
  }

  // The result stored for n, unless the row is gone, still only tallies faults, or holds another intent: the
  // replica was forked or restored.
  std::optional<Json::Value> storedAnswer(std::uint64_t n, const Digest256& digest, const Json::Value& intent) {
    const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::snapshot);
    const std::optional<StoredResult> stored = store_.storedResult(*txn, replica_, n);
    if (!stored || !stored->result) return std::nullopt;
    if (stored->digest != digest) {
      WriteObservation mismatch("sync.intent.digest", catalog_.observationProduct(intent, account_), "sync");
      mismatch.finish("replica-forked");
      return std::nullopt;
    }
    return stored->result;
  }

  // A 409 answers no results. A binding this push inserted goes with it, under the replica row's lock, while
  // nothing was answered under it and it is still this account's: an admission that then finds it gone inserts
  // it again (§6.1 step 3.3).
  SyncReply conflict(Json::Value body, const std::string& error) {
    if (inserted_) {
      const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::write);
      const std::optional<ReplicaRow> row = store_.replica(*txn, replica_, RowLock::update);
      if (row && row->account == account_) store_.unbindUnused(*txn, replica_);
      txn->commit();
    }
    return SyncReply::refused(409, std::move(body), error);
  }

  // Step 6, in a push answered 200: the results the replica acknowledged, never past its last_n, which the response
  // answers as lastN. The row is read without its lock, so an overlapping push's admission never holds the answer
  // up: last_n only grows, and a binding past last_n 0 is never taken away. A binding no longer this account's
  // prunes nothing.
  std::uint64_t prune() {
    const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::write);
    const std::optional<ReplicaRow> row = store_.replica(*txn, replica_, RowLock::none);
    if (!row || row->account != account_) return 0;
    store_.pruneResults(*txn, replica_, std::min(request_["ackThrough"].asUInt64(), row->lastN));
    txn->commit();
    return row->lastN;
  }

  const SyncCatalog& catalog_;
  SyncStore& store_;
  Admission& admission_;
  const UserId account_;
  const Json::Value& request_;
  const std::string replica_;
  const Ms serverNow_;
  bool inserted_ = false;
};

// One stream of a page's merge, a type's typed rows or its spent ids as thin dead rows, read in (seq, id)
// order a batch at a time, each batch strictly after the last row of the one before.
class FeedStream {
public:
  using Read = std::function<std::vector<Row>(const FeedQuery&)>;

  FeedStream(Read read, FeedQuery from) : read_(std::move(read)), query_(std::move(from)) { query_.limit = kFeedBatch; }

  // The stream's next row, or null once it is drained. A pop or a later head() may move it.
  const Row* head() {
    if (next_ == batch_.size() && !drained_) refill();
    return next_ < batch_.size() ? &batch_[next_] : nullptr;
  }

  void pop() { ++next_; }

private:
  void refill() {
    batch_ = read_(query_);
    next_ = 0;
    drained_ = batch_.size() < kFeedBatch;
    if (batch_.empty()) return;
    query_.afterSeq = batch_.back().seq;
    query_.afterKey = batch_.back().id.key();
  }

  Read read_;
  FeedQuery query_;
  std::vector<Row> batch_;
  std::size_t next_ = 0;
  bool drained_ = false;
};

// One scope's feed in a page's snapshot (§6.7), from strictly after a cursor's (seq, type, id), or from the
// start without one: every type of the scope's kind merged in (seq, type, UTF-8 bytes of the id's JCS) order,
// with the spent ids of the types whose dead rows the page sends. A boot (`asOf` set) reads to asOf and keeps
// rows with no life, alive rows, and every row of a derived type; a live page reads every row and spent id.
class ScopeFeed {
public:
  ScopeFeed(const SyncCatalog& catalog, SyncStore& store, SyncTxn& txn, ScopeKey scope, std::optional<Seq> asOf,
            const std::optional<Cursor>& from)
      : catalog_(catalog), store_(store), txn_(txn), scope_(std::move(scope)), asOf_(asOf) {
    for (const TypeDef* type : catalog.typesIn(scope_.registryScope())) {
      const bool keepsDead = !asOf || type->identity == Identity::derived;
      sources_.push_back(Source{.type = type, .aliveOnly = !keepsDead});
      if (type->deadRows == DeadRows::spent && keepsDead) sources_.push_back(Source{.type = type, .spent = true});
    }
    for (const Source& source : sources_) {
      FeedQuery start = queryOf(source);
      if (from) placeAfter(start, *from, source.type->name);
      streams_.emplace_back([this, source](const FeedQuery& query) { return read(source, query); }, start);
    }
  }
  ScopeFeed(const ScopeFeed&) = delete;
  ScopeFeed& operator=(const ScopeFeed&) = delete;

  // Step 3's total: the rows with seq ≤ asOf the boot keeps, wherever the cursor is.
  std::uint64_t total() {
    std::uint64_t rows = 0;
    for (const Source& source : sources_) {
      if (source.spent) rows += store_.countSpent(txn_, scope_, *source.type, queryOf(source));
      else rows += catalog_.store(source.type->name).count(txn_, scope_, queryOf(source));
    }
    return rows;
  }

  // The least row of the streams' heads, or null once every stream is drained; pop() takes it.
  const Row* head() {
    least_ = nullptr;
    const Row* row = nullptr;
    for (FeedStream& stream : streams_) {
      const Row* candidate = stream.head();
      if (candidate && (!row || std::tie(candidate->seq, candidate->t, candidate->id) < std::tie(row->seq, row->t, row->id))) {
        row = candidate;
        least_ = &stream;
      }
    }
    return row;
  }

  void pop() { least_->pop(); }

private:
  struct Source {
    const TypeDef* type = nullptr;
    bool spent = false;
    bool aliveOnly = false;
  };

  FeedQuery queryOf(const Source& source) const {
    return FeedQuery{.throughSeq = asOf_, .aliveOnly = source.aliveOnly};
  }

  // One type's keyset position after the cursor: past its seq when the cursor has no key or the type sorts
  // before the key's, else inside that seq, after the key's id for the key's own type.
  static void placeAfter(FeedQuery& query, const Cursor& from, const std::string& type) {
    if (!from.key || type < from.key->first) {
      query.afterSeq = from.seq + 1;
      return;
    }
    query.afterSeq = from.seq;
    if (type == from.key->first) query.afterKey = from.key->second.key();
  }

  std::vector<Row> read(const Source& source, const FeedQuery& query) {
    if (source.spent) return store_.feedSpent(txn_, scope_, *source.type, query);
    return catalog_.store(source.type->name).feed(txn_, scope_, query);
  }

  const SyncCatalog& catalog_;
  SyncStore& store_;
  SyncTxn& txn_;
  const ScopeKey scope_;
  const std::optional<Seq> asOf_;
  std::vector<Source> sources_;
  std::vector<FeedStream> streams_;
  FeedStream* least_ = nullptr;
};

// A page's rows as a page carries them (dead ones thin), cut before the row whose JCS would take the page past
// `pageBytes`, keeping at least one: its last row, and the seq of the first row left behind, if one is.
struct Cut {
  Json::Value rows = Json::Value(Json::arrayValue);
  std::optional<Row> last;
  std::optional<Seq> nextSeq;
};

Cut cutPage(ScopeFeed& feed, std::size_t pageBytes) {
  Cut cut;
  std::size_t bytes = 0;
  while (const Row* row = feed.head()) {
    Json::Value wire = row->alive() ? row->toJson() : row->thin();
    const std::size_t size = jcs(wire).size();
    if (cut.last && bytes + size > pageBytes) {
      cut.nextSeq = row->seq;
      break;
    }
    bytes += size;
    cut.rows.append(std::move(wire));
    cut.last = *row;
    feed.pop();
  }
  return cut;
}

// A rows page's rows, the cursor after them, and a boot's total.
struct Page {
  Json::Value rows = Json::Value(Json::arrayValue);
  Cursor next;
  std::optional<std::uint64_t> total;
};

// §6.7 for the scopes of one pull request: each after its beforePull commands, from a snapshot of its own.
class ScopePull {
public:
  ScopePull(const SyncCatalog& catalog, SyncStore& store, Admission& admission, const std::optional<UserId>& caller, Ms serverNow)
      : catalog_(catalog), store_(store), admission_(admission), caller_(caller), serverNow_(serverNow) {}

  Json::Value page(const Json::Value& wanted) {
    const std::string ref = wanted["scope"].asString();
    const std::optional<ScopeKey> key = resolve(catalog_.registry(), ref, caller_);
    WriteObservation observation("sync.scope.pull", key ? catalog_.observationProduct(key->registryScope()) : "platform", "sync");
    WriteContext context(observation);
    try {
      if (!key) {
        observation.finish("not-found");
        return answered(ref, "not-found");
      }
      runBeforePull(ref, *key);
      Json::Value page = pageOf(ref, *key, wanted["cursor"]);
      const std::string kind = page["kind"].asString();
      observation.finish(kind == "rows" ? "ok" : kind);
      return page;
    } catch (const ProductScopeUnavailable&) {
      observation.finish("unavailable");
      throw;
    } catch (const std::exception& error) {
      observation.fail(error);
      throw;
    } catch (...) {
      observation.failUnknown();
      throw;
    }
  }

private:
  // Each beforePull command of the scope's kind, in registry order, in an admission of its own as the scope
  // owner's server origin, committed before the page's snapshot. An absent or unreadable scope runs none.
  void runBeforePull(const std::string& ref, const ScopeKey& key) {
    std::vector<std::string> commands;
    for (const CommandDef& command : catalog_.registry().commands()) {
      if (command.beforePull && command.scope == key.registryScope()) commands.push_back(command.name);
    }
    if (commands.empty()) return;
    const std::optional<UserId> owner = readableOwner(key);
    if (!owner) return;
    for (const std::string& name : commands) {
      Json::Value intent(Json::objectValue);
      intent["scope"] = ref;
      intent["cmd"]["name"] = name;
      intent["cmd"]["args"] = Json::Value(Json::objectValue);
      admission_.admit(ServerOrigin{*owner, std::nullopt}, intent, serverNow_);
    }
  }

  std::optional<UserId> readableOwner(const ScopeKey& key) {
    const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::snapshot);
    const std::optional<ScopeRow> scope = store_.scope(*txn, key, RowLock::none);
    if (!scope || !accessIn(*txn, key, scope).read) return std::nullopt;
    return scope->owner;
  }

  // Steps 1–6 from one read-only snapshot: access, reset, then a boot page or a live one.
  Json::Value pageOf(const std::string& ref, const ScopeKey& key, const Json::Value& cursorText) {
    const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::snapshot);
    const std::string epoch = store_.epoch(*txn);
    const std::optional<ScopeRow> scope = store_.scope(*txn, key, RowLock::none);
    const Access access = accessIn(*txn, key, scope);
    if (!access.read) return answered(ref, access.gone ? "gone" : "not-found");
    catalog_.requireReady(*txn, key);
    std::optional<Cursor> cursor;
    if (!cursorText.isNull()) {
      cursor = Cursor::decode(cursorText.asString());
      if (!cursor || cursor->epoch != epoch || cursor->seq > (scope ? scope->seq : 0)) return answered(ref, "reset");
    }
    if (!scope) return rowsPage(ref, Page{.next = Cursor{.epoch = epoch, .live = true}}, 0, Digest256{});
    const bool boot = !cursor || !cursor->live;
    const Page page = boot ? bootPage(*txn, *scope, cursor, epoch) : livePage(*txn, *scope, *cursor, epoch);
    Json::Value answer = rowsPage(ref, page, scope->seq, scope->digest);
    if (key.kind() == ScopeKind::tree) answer["header"]["owner"]["name"] = store_.ownerName(*txn, scope->owner);
    return answer;
  }

  // Step 3: the kept rows with seq ≤ asOf after the cursor; live at asOf once the scan is exhausted.
  Page bootPage(SyncTxn& txn, const ScopeRow& scope, const std::optional<Cursor>& from, const std::string& epoch) {
    const Seq asOf = from ? *from->asOf : scope.seq;
    ScopeFeed feed(catalog_, store_, txn, scope.key, asOf, from);
    Cut cut = cutPage(feed, admission_.limits().pullPageBytes);
    if (!cut.nextSeq) return Page{std::move(cut.rows), Cursor{.epoch = epoch, .live = true, .seq = asOf}, feed.total()};
    const Cursor next{.epoch = epoch, .seq = cut.last->seq, .key = std::pair(cut.last->t, cut.last->id), .asOf = asOf};
    return Page{std::move(cut.rows), next, feed.total()};
  }

  // Step 4: every row after the cursor, dead ones thin; the cursor keeps the last key only inside a seq.
  Page livePage(SyncTxn& txn, const ScopeRow& scope, const Cursor& from, const std::string& epoch) {
    ScopeFeed feed(catalog_, store_, txn, scope.key, std::nullopt, from);
    Cut cut = cutPage(feed, admission_.limits().pullPageBytes);
    if (!cut.last) return Page{std::move(cut.rows), Cursor{.epoch = epoch, .live = true, .seq = from.seq}};
    Cursor next{.epoch = epoch, .live = true, .seq = cut.last->seq};
    if (cut.nextSeq == cut.last->seq) next.key = std::pair(cut.last->t, cut.last->id);
    return Page{std::move(cut.rows), next};
  }

  // Steps 4 and 5: `more` is false iff the cursor after the page is live, keyless and at the scope's seq.
  static Json::Value rowsPage(const std::string& ref, const Page& page, Seq seq, const Digest256& digest) {
    Json::Value answer = answered(ref, "rows");
    answer["rows"] = page.rows;
    answer["cursor"] = page.next.encode();
    answer["more"] = !(page.next.live && !page.next.key && page.next.seq == seq);
    answer["seq"] = Json::UInt64(seq);
    answer["digest"] = digest.hex();
    if (page.total) answer["total"] = Json::UInt64(*page.total);
    return answer;
  }

  static Json::Value answered(const std::string& ref, const std::string& kind) {
    Json::Value page(Json::objectValue);
    page["scope"] = ref;
    page["kind"] = kind;
    return page;
  }

  // Step 1: D-4 as a read sees it in the snapshot, an overlay answering as its tree does.
  Access accessIn(SyncTxn& txn, const ScopeKey& key, const std::optional<ScopeRow>& scope) {
    const std::optional<ScopeRow> tree = key.kind() == ScopeKind::overlay ? store_.scope(txn, key.governingTree(), RowLock::none) : scope;
    return accessOf(key, factsOf(scope), factsOf(tree), caller_);
  }

  const SyncCatalog& catalog_;
  SyncStore& store_;
  Admission& admission_;
  const std::optional<UserId> caller_;
  const Ms serverNow_;
};

}

Json::Value SyncReply::envelope(Ms serverTime, const std::string& epoch) {
  Json::Value body(Json::objectValue);
  body["serverTime"] = Json::UInt64(serverTime);
  body["epoch"] = epoch;
  return body;
}

SyncReply SyncReply::refused(int status, Json::Value envelope, const std::string& error) {
  envelope["error"] = error;
  return SyncReply{status, std::move(envelope)};
}

SyncReply SyncReply::unauthenticated(Json::Value envelope) {
  envelope["as"] = Json::Value(Json::nullValue);
  return refused(401, std::move(envelope), "unauthenticated");
}

SyncReply SyncReply::unavailable(Json::Value envelope) {
  envelope["retryAfterMs"] = Json::UInt(Retry::kTransientMs);
  return refused(503, std::move(envelope), "unavailable");
}

TimeBudget::TimeBudget(Ms workMs) : deadline_(std::chrono::steady_clock::now() + std::chrono::milliseconds(workMs)) {}

bool TimeBudget::spent(std::size_t admitted) {
  return admitted >= 1 && std::chrono::steady_clock::now() >= deadline_;
}

SyncService::SyncService(const SyncCatalog& catalog, SyncStore& store, Admission& admission, Clock& clock)
    : catalog_(catalog), store_(store), admission_(admission), clock_(clock) {}

// §9.2: holdsRecords[p] iff acct:<caller>/<p> holds a visible row of a primary type, from one snapshot.
SyncReply SyncService::hello(const Credential& credential) {
  const Ms serverTime = clock_.nowMs();
  const Registry& registry = catalog_.registry();
  const std::unique_ptr<SyncTxn> txn = store_.begin(TxnMode::snapshot);
  Json::Value body = SyncReply::envelope(serverTime, store_.epoch(*txn));
  if (credential.fails()) return SyncReply::unauthenticated(std::move(body));
  const std::optional<UserId>& caller = credential.servedAs();
  body["as"] = servedAsJson(caller);
  Json::Value holds(Json::objectValue);
  try {
    if (caller) {
      for (const auto& [product, def] : registry.products()) {
        const ScopeKey scope = ScopeKey::product(*caller, product);
        catalog_.requireReady(*txn, scope);
        const std::vector<const TypeDef*> types = catalog_.typesIn(scope.registryScope());
        holds[product] = std::any_of(types.begin(), types.end(), [&](const TypeDef* type) {
          return type->primary && !catalog_.store(type->name).feed(*txn, scope, FeedQuery{.visibleOnly = true, .limit = 1}).empty();
        });
      }
    }
  } catch (const ProductScopeUnavailable&) {
    return SyncReply::unavailable(std::move(body));
  }
  body["schema"] = Json::Int64(registry.version());
  body["minSchema"] = Json::Int64(registry.minVersion());
  if (caller) body["holdsRecords"] = std::move(holds);
  return SyncReply{200, std::move(body)};
}

SyncReply SyncService::push(const Credential& credential, std::string_view body, PushBudget& budget) {
  const Ms serverNow = clock_.nowMs();
  const Limits& limits = admission_.limits();
  Json::Value answer = SyncReply::envelope(serverNow, epochOf(store_));
  const std::optional<UserId>& caller = credential.servedAs();
  if (credential.fails() || !caller) return SyncReply::unauthenticated(std::move(answer));
  answer["as"] = servedAsJson(caller);
  if (body.size() > limits.pushMaxBytes) return SyncReply::refused(413, std::move(answer), "request-too-large");
  const std::optional<Json::Value> request = parsed(body);
  if (!request || !isPushRequest(*request)) return SyncReply::refused(400, std::move(answer), "malformed");
  if ((*request)["intents"].size() > limits.pushMaxIntents) return SyncReply::refused(413, std::move(answer), "request-too-large");
  return ReplicaPush(catalog_, store_, admission_, *caller, *request, serverNow).run(budget, std::move(answer));
}

SyncReply SyncService::pull(const Credential& credential, std::string_view body) {
  const Ms serverNow = clock_.nowMs();
  const Limits& limits = admission_.limits();
  Json::Value answer = SyncReply::envelope(serverNow, epochOf(store_));
  if (credential.fails()) return SyncReply::unauthenticated(std::move(answer));
  const std::optional<UserId>& caller = credential.servedAs();
  answer["as"] = servedAsJson(caller);
  if (body.size() > limits.pullMaxBytes) return SyncReply::refused(413, std::move(answer), "request-too-large");
  const std::optional<Json::Value> request = parsed(body);
  if (!request || !isPullRequest(*request) || (*request)["scopes"].size() > limits.pullMaxScopes)
    return SyncReply::refused(400, std::move(answer), "malformed");
  ScopePull pull(catalog_, store_, admission_, caller, serverNow);
  Json::Value& pages = answer["pages"] = Json::Value(Json::arrayValue);
  try {
    for (const Json::Value& wanted : (*request)["scopes"]) pages.append(pull.page(wanted));
  } catch (const ProductScopeUnavailable&) {
    answer.removeMember("pages");
    return SyncReply::unavailable(std::move(answer));
  }
  return SyncReply{200, std::move(answer)};
}

}
