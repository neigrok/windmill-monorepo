#include "platform/application/sync/Admission.h"

#include "platform/application/WorkerPool.h"

#include "platform/domain/sync/Admit.h"
#include "platform/domain/sync/Shape.h"

#include <algorithm>
#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <typeinfo>
#include <utility>
#include <vector>

namespace wm::sync {

namespace {

std::string partId(const CallPart& call) {
  return call.requestId + "#" + std::to_string(call.k);
}

// A record's id as an advisory lock names it (§6.1 step 3.6).
std::pair<std::string, std::string> globalIdOf(const std::string& type, const RecordId& id) {
  return {type, id.column()};
}

}

std::uint64_t PhysicalClock::nowMs() {
  const std::uint64_t wall = wall_.nowMs();
  std::uint64_t highest = highest_.load();
  while (wall > highest && !highest_.compare_exchange_weak(highest, wall)) {
  }
  return std::max(wall, highest);
}

HlcClock ServerClock::copy() const {
  std::lock_guard lock(mutex_);
  return HlcClock("srv", state_);
}

void ServerClock::fold(const HlcClock::State& state) {
  std::lock_guard lock(mutex_);
  if (std::pair(state.ms, state.counter) > std::pair(state_.ms, state_.counter)) state_ = state;
}

HlcClock::State ServerClock::state() const {
  std::lock_guard lock(mutex_);
  return state_;
}

// One admission of one intent: the §6.1 steps in order over the collaborators of its Admission, and the
// SyncReader a product's check and command read through.
class Admission::Attempt final : public SyncReader {
public:
  Attempt(Admission& admission, const Origin& origin, const Json::Value& wire, Ms now, const ServerBuilder* builder = nullptr)
      : a_(admission),
        registry_(admission.catalog_.registry()),
        origin_(origin),
        wire_(wire),
        now_(now),
        caller_{std::visit([](const auto& o) { return o.account; }, origin), std::holds_alternative<ServerOrigin>(origin)}, builder_(builder) {}

  AdmitOutcome run() {
    if (std::optional<AdmitOutcome> answered = answeredCall()) return *answered;
    try {
      shaped_.emplace(shapeIntent(registry_, wire_, Sender{caller_.account, caller_.server}, now_, a_.limits_.maxSkewMs));
    } catch (const Refusal& refusal) {
      return answerRefusal(refusal.refused);
    } catch (const std::exception& error) {
      return answerFault(error);
    }
    std::unique_lock<std::timed_mutex> stripe;
    AdmitOutcome outcome = [this, &stripe]() -> AdmitOutcome {
      try {
        stripe = a_.takeStripe(shaped_->scope);
        clock_ = a_.clock_.copy();
        return admitUnderLock();
      } catch (const ServerBuildAborted& aborted) {
        txn_.reset();
        std::rethrow_exception(aborted.error);
      } catch (const Refusal& refusal) {
        txn_.reset();
        return answerRefusal(refusal.refused);
      } catch (const std::exception& error) {
        txn_.reset();
        return answerFault(error);
      }
    }();
    txn_.reset();  // an answer that committed nothing rolls back before the scope's mutex is released
    return outcome;
  }

  const Locked& lock(const std::string& type, const RecordId& id) override {
    lockRecords(scope(), {{type, id}});
    return records_.at(RecordRef{scope(), type, id});
  }

  std::vector<Row> scan(const std::string& type, const FeedQuery& query) override {
    return a_.catalog_.store(type).feed(*txn_, scope(), query);
  }

  std::optional<ScopeRow> scope(const ScopeKey& key) override {
    if (key == scope()) return scopeRow_;
    if (const auto locked = scopes_.find(key); locked != scopes_.end()) return locked->second;
    return a_.store_.scope(*txn_, key, RowLock::none);
  }

  std::vector<Row> scanScope(const ScopeKey& key, const std::string& type, const FeedQuery& query) override {
    return a_.catalog_.store(type).feed(*txn_, key, query);
  }

private:
  const ScopeKey& scope() const { return shaped_->scope; }
  const Intent& intent() const { return shaped_->intent; }
  SyncStore& store() { return a_.store_; }
  const ReplicaOrigin* replica() const { return std::get_if<ReplicaOrigin>(&origin_); }
  const CallPart* call() const {
    const ServerOrigin* server = std::get_if<ServerOrigin>(&origin_);
    return server && server->call ? &*server->call : nullptr;
  }

  // §6.3 steps 1 and 2 before the intent is shaped or its scope taken: a call the lookup answers whole, or a part a
  // run of the call stored, is answered from a transaction that holds only the call's lock and writes nothing, so a
  // replay runs no admit. Step 4 asks again under the scope's lock, for a run that stored the part meanwhile.
  std::optional<AdmitOutcome> answeredCall() {
    const CallPart* part = call();
    if (!part) return std::nullopt;
    try {
      txn_ = store().begin(TxnMode::write);
      store().lockRequest(*txn_, caller_.account, part->requestId);
      std::optional<AdmitOutcome> answered = storedAnswer(*part);
      txn_.reset();
      return answered;
    } catch (const std::exception& error) {
      txn_.reset();
      return answerFault(error);
    }
  }

  AdmitOutcome admitUnderLock() {
    txn_ = store().begin(TxnMode::write);                                 // 3.2
    if (std::optional<OutOfTurn> out = lockOrigin()) return *out;         // 3.3
    lockScopes();                                                         // 3.4, 3.5
    lockFreshIds();                                                       // 3.6
    checkAccess();                                                        // 3.7
    if (std::optional<AdmitOutcome> answered = lookUpCall()) return *answered;  // 4
    if (builder_) {
      const std::optional<Json::Value> built = (*builder_)(*txn_);
      if (!built) {
        const Json::Value result = okResult(scopeRow_->seq, std::nullopt, {});
        recordResult(result);
        txn_->commit();
        return Admitted{result};
      }
      builtWire_ = *built;
      Shaped shaped = shapeIntent(registry_, *builtWire_, Sender{caller_.account, true}, now_, a_.limits_.maxSkewMs);
      if (shaped.scope != scope() || shaped.scope.kind() == ScopeKind::tree || shaped.scope.kind() == ScopeKind::overlay)
        throw Refusal(code::invalid);
      shaped_ = std::move(shaped);
      lockFreshIds();
      checkAccess();
    }
    changes_.emplace(registry_, scope(), now_, a_.limits_);
    lockIntentRecords();                                                  // 5
    admitDeltas(scope(), intent().d, caller_.server ? Source::server : Source::client);  // 6
    checkGuardsUnlessReplay();                                            // 7
    runCommand();                                                         // 8
    join();                                                               // 9
    checkProduct();                                                       // 10
    checkParents();                                                       // 10
    assignSerials();                                                      // 11
    checkCaps();                                                          // 12
    applyIntentScope();                                                   // 13
    applyLifecycle();                                                     // 15
    applyCreatedScopes();                                                 // 14
    const Json::Value result = okResult(scopeRow_->seq, commandWriteMap(), detail_);  // 16
    recordResult(result);
    commitAndPublish();                                                   // 17
    return Admitted{result};
  }

  // 3.3 in the open transaction: a replica locks its row, inserted again at last_n 0 when a push's 409 deleted it
  // (§6.2 step 3), and re-checks its turn, the account first; a call locks its requestId.
  std::optional<OutOfTurn> lockOrigin() {
    if (const ReplicaOrigin* origin = replica()) {
      const Turn turn = store().bindReplica(*txn_, origin->replica, origin->account, now_).turnOf(origin->account, origin->n);
      if (turn != Turn::next) return OutOfTurn{turn};
    }
    if (const CallPart* part = call()) store().lockRequest(*txn_, caller_.account, part->requestId);
    return std::nullopt;
  }

  // 3.4 and 3.5: an overlay's tree held shared; an absent scope a write may create inserted; then, in one
  // ascending pass, the intent's scope row and every tree a command argument names.
  void lockScopes() {
    if (scope().kind() == ScopeKind::overlay) tree_ = store().scope(*txn_, scope().governingTree(), RowLock::keyShare);
    const std::optional<ScopeRow> current = store().scope(*txn_, scope(), RowLock::none);
    if (accessWith(current).create) {
      const std::optional<std::string> governedBy =
          scope().kind() == ScopeKind::overlay ? std::optional(scope().governingTree().text()) : std::nullopt;
      store().insertScope(*txn_, scope(), caller_.account, governedBy);
    }
    std::map<ScopeKey, RowLock> pass{{scope(), RowLock::noKeyUpdate}};
    for (const ScopeKey& tree : argumentTrees()) pass.emplace(tree, RowLock::share);
    for (const auto& [key, mode] : pass) {
      std::optional<ScopeRow> row = store().scope(*txn_, key, mode);
      if (key == scope()) scopeRow_ = std::move(row);
      else if (row) scopes_.emplace(key, std::move(*row));
    }
  }

  // 3.6: every fresh global id the intent creates, and every global id a command argument names.
  void lockFreshIds() {
    std::vector<std::pair<std::string, RecordId>> fresh;
    for (const Delta& delta : intent().d) {
      const TypeDef& type = *registry_.type(delta.t);
      if (type.idSpace == IdSpace::global && opOf(type, delta) == Op::create) fresh.emplace_back(delta.t, delta.id);
    }
    for (const auto& [type, id] : argumentRecords()) {
      if (registry_.type(type)->idSpace == IdSpace::global) fresh.emplace_back(type, id);
    }
    lockGlobalIds(fresh);
  }

  // 3.7: not-found, scope-dead or forbidden, then the origin rules.
  void checkAccess() {
    const Access access = accessWith(scopeRow_);
    if (!access.write) throw Refusal(access.refusal);
    for (const Delta& delta : intent().d) {
      const Origins& origins = registry_.type(delta.t)->origins;
      if (!(caller_.server ? origins.server : origins.replica)) throw Refusal(code::forbidden);
    }
    if (!intent().cmd) return;
    const CommandDef& def = *registry_.command(intent().cmd->name);
    if ((def.serverInternal && !caller_.server) || !(caller_.server ? def.origins.server : def.origins.replica)) throw Refusal(code::forbidden);
  }

  Access accessWith(const std::optional<ScopeRow>& row) const {
    std::optional<ScopeFacts> facts;
    if (row) facts = row->facts();
    std::optional<ScopeFacts> tree = facts;
    if (scope().kind() == ScopeKind::overlay) tree = tree_ ? std::optional(tree_->facts()) : std::nullopt;
    return accessOf(scope(), facts, tree, caller_.account);
  }

  // 4: the answer the store already holds for this admit, a replayed part included, which writes nothing; otherwise
  // the call's row is running from here, its lease taken, taken over or refreshed in this admit's transaction, so a
  // transient failure of the admit takes it back.
  std::optional<AdmitOutcome> lookUpCall() {
    const CallPart* part = call();
    if (!part) return std::nullopt;
    if (std::optional<AdmitOutcome> answered = storedAnswer(*part)) return answered;
    store().putRequest(*txn_, caller_.account, RequestRow{part->requestId, part->digest, true, std::nullopt, now_});
    return std::nullopt;
  }

  // §6.3 under the call's lock: the call's first admit to run looks the call up (its final result,
  // request-conflict or request-running), and every admit finds its part k when a run of the call stored it.
  std::optional<AdmitOutcome> storedAnswer(const CallPart& part) {
    if (part.looksUp) {
      if (std::optional<Json::Value> answered = callAnswer(part)) return CallAnswered{*answered};
    }
    const std::optional<RequestRow> stored = store().request(*txn_, caller_.account, partId(part));
    if (!stored || !stored->result) return std::nullopt;
    if (stored->digest != part.digest) return CallAnswered{refusedResult(Refused{code::requestConflict, {}})};
    return Replayed{*stored->result};
  }

  // §6.3 step 1's lookup, under the call's lock.
  std::optional<Json::Value> callAnswer(const CallPart& part) {
    const std::optional<RequestRow> row = store().request(*txn_, caller_.account, part.requestId);
    if (!row) return std::nullopt;
    if (row->digest != part.digest) return refusedResult(Refused{code::requestConflict, {}});
    if (!row->running && row->result) return *row->result;
    if (now_ < row->startedAt + a_.limits_.requestLeaseMs) return refusedResult(Refused{code::requestRunning, {}});
    return std::nullopt;
  }

  // 5: every record the deltas, guards and command arguments of the intent's scope touch.
  void lockIntentRecords() {
    std::vector<std::pair<std::string, RecordId>> touched;
    for (const Delta& delta : intent().d) touched.emplace_back(delta.t, delta.id);
    for (const Guard& guard : intent().guard) touched.emplace_back(guard.t, guard.id);
    for (const auto& [type, id] : argumentRecords()) {
      if (registry_.type(type)->scope == scope().registryScope()) touched.emplace_back(type, id);
    }
    lockRecords(scope(), touched);
  }

  // 5 and 6 for a group of deltas into one scope.
  void admitDeltas(const ScopeKey& into, const std::vector<Delta>& deltas, Source source) {
    std::vector<std::pair<std::string, RecordId>> touched;
    for (const Delta& delta : deltas) touched.emplace_back(delta.t, delta.id);
    lockRecords(into, touched);
    for (const Delta& delta : deltas) {
      changes_->admit(*registry_.type(delta.t), into, delta, source, records_.at(RecordRef{into, delta.t, delta.id}));
    }
  }

  // 7.
  void checkGuardsUnlessReplay() {
    if (intent().cmd) {
      CommandCtx ctx = commandCtx();
      if (a_.catalog_.command(intent().cmd->name).isReplay(ctx)) return;
    }
    std::map<RecordRef, std::optional<Row>> stored;
    for (const Guard& guard : intent().guard) {
      const RecordRef ref{scope(), guard.t, guard.id};
      stored.emplace(ref, records_.at(ref).stored);
    }
    checkGuards(intent(), stored, scope());
  }

  // 8.
  void runCommand() {
    if (!intent().cmd) return;
    CommandCtx ctx = commandCtx();
    CommandOutcome outcome = a_.catalog_.command(intent().cmd->name).run(ctx);
    changes_->setWriteMap(std::move(outcome.write));
    detail_ = std::move(outcome.detail);
    admitDeltas(scope(), outcome.deltas, Source::command);
    for (const IntoScope& into : outcome.into) admitDeltas(into.scope, into.deltas, Source::command);
  }

  // 9, one pass: its server stamp, then the joins, text merges and the record bound.
  void join() {
    changes_->mint(clock_);
    std::map<RevisionWanted, std::optional<std::string>> revisions;
    for (const RevisionWanted& wanted : changes_->revisionsWanted()) {
      const RecordRef& record = wanted.record;
      revisions.emplace(wanted, a_.catalog_.store(record.t).revisionText(*txn_, record.scope, record.id, wanted.field, wanted.rev));
    }
    changes_->join(revisions, {{scope().text(), scopeRow_->seq}});
  }

  // 10: each touched type's rules once, in registry order; the deltas they append pass 5, 6 and 9.
  void checkProduct() {
    std::set<std::string> touched;
    for (const Change& change : changes_->changes()) touched.insert(change.type->name);
    std::vector<Delta> appended;
    const CheckCtx ctx{registry_, *scopeRow_, caller_, now_, *this, *txn_, intent()};
    std::set<TypeRules*> checked;
    for (const TypeDef& type : registry_.types()) {
      TypeRules* rules = touched.contains(type.name) ? a_.catalog_.rules(type.name) : nullptr;
      if (!rules || !checked.insert(rules).second) continue;
      std::vector<Delta> deltas = rules->check(ctx, changes_->changes());
      appended.insert(appended.end(), std::make_move_iterator(deltas.begin()), std::make_move_iterator(deltas.end()));
    }
    if (appended.empty()) return;
    admitDeltas(scope(), appended, Source::check);
    join();
  }

  // 10's parent rule.
  void checkParents() {
    std::map<RecordRef, std::optional<Row>> parents;
    for (const RecordRef& parent : changes_->parentsWanted()) {
      lockRecords(parent.scope, {{parent.t, parent.id}});
      parents.emplace(parent, records_.at(parent).stored);
    }
    changes_->checkParents(parents);
  }

  // 11.
  void assignSerials() {
    std::map<std::string, std::optional<std::int64_t>> maxima;
    for (const SerialWanted& wanted : changes_->serialsWanted()) {
      maxima.emplace(wanted.key(), a_.catalog_.store(wanted.type->name).maxSerial(*txn_, wanted.scope, wanted.field, wanted.match));
    }
    changes_->assignSerials(maxima);
  }

  // 12.
  void checkCaps() {
    changes_->checkCaps({{scope().text(), scopeRow_->counters}});
  }

  // 13 for the intent's scope.
  void applyIntentScope() {
    const ScopeRow& row = *scopeRow_;
    if (std::optional<ScopeWrite> write = changes_->stage(scope(), row.seq, row.counters, row.digest, row.open, a_.catalog_.opening())) {
      persist(*write, *scopeRow_);
    }
  }

  // 15: a governing create inserts its tree; a governing death kills the tree and its overlays.
  void applyLifecycle() {
    for (const Governed& governed : changes_->lifecycle()) {
      if (governed.created) {
        if (store().insertScope(*txn_, governed.tree, caller_.account, governed.governedBy)) created_.insert(governed.tree);
        continue;
      }
      std::vector<ScopeKey> killed = store().killTree(*txn_, governed.tree, now_);
      killed_.insert(killed_.end(), killed.begin(), killed.end());
    }
  }

  // 14: a command's writes into the scopes this intent created, each at its own seq and digest.
  void applyCreatedScopes() {
    for (const ScopeKey& key : changes_->otherScopes()) {
      if (!created_.contains(key)) throw std::logic_error("a command wrote into " + key.text() + ", which this intent did not create");
      std::optional<ScopeRow> row = store().scope(*txn_, key, RowLock::none);
      if (std::optional<ScopeWrite> write = changes_->stage(key, row->seq, row->counters, row->digest, row->open, a_.catalog_.opening())) {
        persist(*write, *row);
      }
    }
  }

  // 13's writes for one scope: its row, its types' rows (remaining rows in ref order, deletions in
  // reverse), its spent ids, and what the live frame carries.
  void persist(const ScopeWrite& write, ScopeRow& row) {
    row.seq = write.seq;
    row.counters = write.counters;
    row.digest = write.digest;
    row.open = write.open;
    store().saveScope(*txn_, row);
    const std::vector<const TypeDef*>& order = a_.catalog_.applyOrder();
    auto applyWhere = [&](const TypeDef* type, bool remaining) {
      std::vector<RowWrite> rows;
      for (const RowWrite& rowWrite : write.rows) {
        if (rowWrite.type == type && rowWrite.after.has_value() == remaining) rows.push_back(rowWrite);
      }
      if (!rows.empty()) a_.catalog_.store(type->name).apply(*txn_, write.scope, rows);
    };
    for (const TypeDef* type : order) applyWhere(type, true);
    for (auto type = order.rbegin(); type != order.rend(); ++type) applyWhere(*type, false);
    for (const Row& spent : write.spentAdded) store().addSpent(*txn_, write.scope, spent);
    for (const auto& [type, id] : write.spentRemoved) store().removeSpent(*txn_, write.scope, *registry_.type(type), id);
    published_.push_back(ScopeChange{write.scope, row.owner, write.open, write.seq, write.digest, write.frameRows});
  }

  std::optional<std::vector<WriteEntry>> commandWriteMap() const {
    if (!intent().cmd) return std::nullopt;
    return changes_->writeMap().value_or(std::vector<WriteEntry>{});
  }

  // 16: a replica's result and last_n, or a call's part; the call writes its own result after its last part (§6.3).
  void recordResult(const Json::Value& result) {
    if (const ReplicaOrigin* origin = replica()) {
      store().putResult(*txn_, origin->replica, StoredResult{origin->n, origin->digest, result, 0});
      store().setLastN(*txn_, origin->replica, origin->n);
    }
    if (const CallPart* part = call()) store().putRequest(*txn_, caller_.account, RequestRow{partId(*part), part->digest, false, result, now_});
  }

  // 17: commit, then publish while the scope's mutex is still held, so its frames leave in seq order. The
  // intent is admitted once COMMIT returns: a publish that fails is reported, never answered as a fault.
  void commitAndPublish() {
    if (published_.empty() && killed_.empty()) {
      txn_->commit();
      a_.clock_.fold(clock_.state());
      return;
    }
    CommittedChange change{store().epoch(*txn_), std::move(published_), std::move(killed_)};
    txn_->commit();
    a_.clock_.fold(clock_.state());
    try {
      a_.feed_.publish(change);
    } catch (const std::exception& error) {
      report(error);
    }
  }

  // Step R: the refusal is the answer, stored as step 16 stores a result, in a transaction of its own that re-checks
  // the origin as step 3.3 does and looks a call up as step 4 does. A failure of that transaction is classified as
  // any other (§6.6). A server origin without a requestId stores nothing.
  AdmitOutcome answerRefusal(const Refused& refused) {
    const Json::Value result = refusedResult(refused);
    if (!replica() && !call()) return Admitted{result};
    try {
      txn_ = store().begin(TxnMode::write);
      if (std::optional<OutOfTurn> out = lockOrigin()) return *out;
      if (std::optional<AdmitOutcome> answered = lookUpCall()) return *answered;
      recordResult(result);
      txn_->commit();
      return Admitted{result};
    } catch (const std::exception& error) {
      txn_.reset();
      return answerFault(error);
    }
  }

  // §6.6: a transient failure records nothing; a fault is tallied toward poison for a replica, in a transaction
  // that re-checks the origin as step 3.3 does, and ends a server-origin call refused internal: its part k and its
  // row, done, in one transaction, unless the store already holds this admit's answer.
  AdmitOutcome answerFault(const std::exception& error) {
    const bool transient = dynamic_cast<const ScopeLockTimeout*>(&error) || dynamic_cast<const WorkerPoolStopping*>(&error) ||
                           a_.store_.classify(error) == FaultClass::transient;
    if (transient) return Retry{Retry::kTransientMs};
    report(error);
    const Json::Value internal = refusedResult(Refused{code::internal, {}});
    if (!replica() && !call()) return Admitted{internal};
    try {
      txn_ = store().begin(TxnMode::write);
      if (std::optional<OutOfTurn> out = lockOrigin()) return *out;
      if (const ReplicaOrigin* origin = replica()) {
        const std::optional<StoredResult> previous = store().storedResult(*txn_, origin->replica, origin->n);
        const int faults = (previous && previous->digest == origin->digest ? previous->faults : 0) + 1;
        if (faults < a_.limits_.kPoison) {
          store().putResult(*txn_, origin->replica, StoredResult{origin->n, origin->digest, std::nullopt, faults});
          txn_->commit();
          return Retry{0};
        }
        store().putResult(*txn_, origin->replica, StoredResult{origin->n, origin->digest, internal, faults});
        store().setLastN(*txn_, origin->replica, origin->n);
        txn_->commit();
        return Admitted{internal};
      }
      const CallPart& part = *call();
      if (std::optional<AdmitOutcome> answered = storedAnswer(part)) return *answered;
      store().putRequest(*txn_, caller_.account, RequestRow{partId(part), part.digest, false, internal, now_});
      store().putRequest(*txn_, caller_.account, RequestRow{part.requestId, part.digest, false, internal, now_});
      txn_->commit();
      return Admitted{internal};
    } catch (const std::exception& second) {
      txn_.reset();
      if (a_.store_.classify(second) == FaultClass::fault) report(second);
      return Retry{Retry::kTransientMs};
    }
  }

  void report(const std::exception& error) {
    try {
      a_.failures_.report("sync.fault", "sync.admit", std::string("type=") + typeid(error).name());
    } catch (const std::exception&) {
    }
  }

  CommandCtx commandCtx() {
    const Json::Value& wire = builtWire_ ? *builtWire_ : wire_;
    return CommandCtx{registry_, *scopeRow_, caller_, now_, intent().cmd->args, *this, *txn_, wire["cmd"]["args"]};
  }

  // The records a command's `ref<t>` arguments name.
  std::vector<std::pair<std::string, RecordId>> argumentRecords() const {
    std::vector<std::pair<std::string, RecordId>> records;
    if (!intent().cmd) return records;
    const Json::Value& args = intent().cmd->args;
    for (const auto& [name, arg] : registry_.command(intent().cmd->name)->args) {
      if (arg.type == ArgType::ref && args.isMember(name)) records.emplace_back(*arg.ref, RecordId(args[name]));
    }
    return records;
  }

  // 3.5: the trees a command's arguments name through a governing type.
  std::vector<ScopeKey> argumentTrees() const {
    std::vector<ScopeKey> trees;
    for (const auto& [type, id] : argumentRecords()) {
      if (registry_.type(type)->governsTree) trees.push_back(ScopeKey::tree(id.column()));
    }
    return trees;
  }

  void lockGlobalIds(const std::vector<std::pair<std::string, RecordId>>& records) {
    std::set<std::pair<std::string, std::string>> fresh;
    for (const auto& [type, id] : records) {
      if (!lockedIds_.contains(globalIdOf(type, id))) fresh.insert(globalIdOf(type, id));
    }
    if (fresh.empty()) return;
    store().lockIds(*txn_, {fresh.begin(), fresh.end()});
    lockedIds_.insert(fresh.begin(), fresh.end());
  }

  // Step 5 for a group of records of one scope: per type in registry order, ids ascending, the typed rows
  // FOR UPDATE, composed with the engine's tables into each record's id state (§4.2). A global id first
  // revealed here is locked on demand (§4.2).
  void lockRecords(const ScopeKey& in, const std::vector<std::pair<std::string, RecordId>>& touched) {
    for (const TypeDef& type : registry_.types()) {
      std::set<RecordId> fresh;
      for (const auto& [name, id] : touched) {
        if (name == type.name && !records_.contains(RecordRef{in, name, id})) fresh.insert(id);
      }
      if (fresh.empty()) continue;
      const std::vector<RecordId> ids(fresh.begin(), fresh.end());
      const bool global = type.idSpace == IdSpace::global;
      const bool spends = type.deadRows == DeadRows::spent;
      if (global) {
        std::vector<std::pair<std::string, RecordId>> named;
        for (const RecordId& id : ids) named.emplace_back(type.name, id);
        lockGlobalIds(named);
      }
      TypeStore& typeStore = a_.catalog_.store(type.name);
      std::map<std::string, Row> typed = typeStore.lock(*txn_, in, ids);
      std::map<std::string, Row> spent = spends ? store().spentIn(*txn_, in, type, ids) : std::map<std::string, Row>{};
      std::set<std::string> elsewhere = global ? typeStore.elsewhere(*txn_, in, ids) : std::set<std::string>{};
      if (global && spends) elsewhere.merge(store().spentElsewhere(*txn_, in, type, ids));
      for (const RecordId& id : ids) {
        std::optional<std::optional<std::string>> governed;
        if (type.governsTree) {
          if (const std::optional<ScopeRow> tree = store().scope(*txn_, ScopeKey::tree(id.column()), RowLock::none)) governed = tree->governedBy;
        }
        auto take = [&id](std::map<std::string, Row>& rows) {
          const auto found = rows.find(id.key());
          return found == rows.end() ? std::optional<Row>() : std::optional<Row>(std::move(found->second));
        };
        records_.insert_or_assign(RecordRef{in, type.name, id},
                                  Locked::compose(type, in, id, take(typed), take(spent), elsewhere.contains(id.key()), governed));
      }
    }
  }

  Admission& a_;
  const Registry& registry_;
  const Origin& origin_;
  const Json::Value& wire_;
  std::optional<Json::Value> builtWire_;
  const Ms now_;
  const Caller caller_;
  const ServerBuilder* builder_;
  HlcClock clock_{"srv"};
  std::optional<Shaped> shaped_;
  std::unique_ptr<SyncTxn> txn_;
  std::optional<ScopeRow> tree_;
  std::optional<ScopeRow> scopeRow_;
  std::map<ScopeKey, ScopeRow> scopes_;
  std::set<std::pair<std::string, std::string>> lockedIds_;
  std::map<RecordRef, Locked> records_;
  std::optional<ChangeSet> changes_;
  Json::Value detail_;
  std::vector<ScopeChange> published_;
  std::vector<ScopeKey> killed_;
  std::set<ScopeKey> created_;
};

Admission::Admission(const SyncCatalog& catalog, SyncStore& store, ChangeFeed& feed, ServerClock& clock, FailureReporter& failures, Limits limits)
    : catalog_(catalog), store_(store), feed_(feed), clock_(clock), failures_(failures), limits_(limits) {}

AdmitOutcome Admission::admit(const Origin& origin, const Json::Value& intent, Ms serverNow) {
  requireBlockingThread();
  return Attempt(*this, origin, intent, serverNow).run();
}

AdmitOutcome Admission::admitBuilt(const ServerOrigin& origin, const Json::Value& scopeIntent, Ms serverNow, const ServerBuilder& builder) {
  requireBlockingThread();
  const Origin server = origin;
  return Attempt(*this, server, scopeIntent, serverNow, &builder).run();
}

std::unique_lock<std::timed_mutex> Admission::takeStripe(const ScopeKey& scope) {
  std::unique_lock<std::timed_mutex> stripe(stripes_[std::hash<std::string>{}(scope.text()) % stripes_.size()], std::defer_lock);
  if (!stripe.try_lock_for(std::chrono::milliseconds(limits_.lockTimeoutMs))) throw ScopeLockTimeout("the scope " + scope.text() + " stayed locked");
  return stripe;
}

}
