#include "products/gym/sync/GymProduct.h"

#include "platform/domain/sync/Jcs.h"
#include "products/gym/sync/GymRules.h"

namespace wm::gym::engine {

using namespace sync;

const Registry& registry() {
  static const Registry gym{parseJson(registryText())};
  return gym;
}

namespace {

GymFacts load(GymState& state, SyncTxn& txn, const ScopeKey& scope, SyncReader& read, const Registry& registry) {
  GymFacts facts;
  facts.books = state.load(txn, scope);
  for (const char* type : {"routine", "routineCreation", "exercise", "exerciseName", "session", "set", "note", "weighin", "prefs", "proposal"}) {
    if (!registry.type(type)) continue;
    for (Row& row : read.scan(type)) facts.rows.push_back(std::move(row));
  }
  return facts;
}

}

class GymProduct::Rules final : public TypeRules {
public:
  explicit Rules(GymState& state) : state_(state) {}
  std::vector<Delta> check(const CheckCtx& ctx, const std::vector<Change>& changes) override {
    return checkGym(load(state_, ctx.txn, ctx.scope.key, ctx.read, ctx.registry), changes, ctx.intent, ctx.caller.server, ctx.serverNow);
  }
private:
  GymState& state_;
};

class GymProduct::Command final : public SyncCommand {
public:
  Command(GymState& state, std::string name) : state_(state), name_(std::move(name)) {}
  const std::string& name() const { return name_; }

  bool isReplay(CommandCtx& ctx) override {
    const Json::Value books = state_.load(ctx.txn, ctx.scope.key);
    if (name_ == "gym.start") return books["starts"].isMember(ctx.args["id"].asString());
    if (name_ == "gym.importSession") return books["imports"].isMember(ctx.args["id"].asString()) || books["importHashes"].isMember(ctx.args["id"].asString());
    if (name_ == "gym.correctSession") return books["corrections"].isMember(ctx.args["requestId"].asString());
    return false;
  }

  CommandOutcome run(CommandCtx& ctx) override {
    GymFacts facts = load(state_, ctx.txn, ctx.scope.key, ctx.read, ctx.registry);
    auto lock = [&](const std::string& type, const Json::Value& id) {
      if (!id.isString()) return;
      facts.locked.insert_or_assign({type, id.asString()}, ctx.read.lock(type, RecordId(id)));
    };
    for (const char* id : {"id", "sessionId"}) if (ctx.args.isMember(id)) lock("session", ctx.args[id]);
    if (ctx.args.isMember("proposalId")) lock("proposal", ctx.args["proposalId"]);
    if (ctx.args.isMember("routineId")) lock("routine", ctx.args["routineId"]);
    if (name_ == "gym.start") {
      const Json::Value resolved = facts.books["starts"][ctx.args["id"].asString()];
      if (resolved.isString()) lock("session", resolved);
    }
    for (const Json::Value& set : ctx.args["sets"]) lock("set", set["id"]);
    GymOutcome outcome = runGym(name_, ctx.args, ctx.rawArgs, facts, ctx.serverNow);
    if (!outcome.receiptKind.empty()) state_.receipt(ctx.txn, ctx.scope.key, outcome.receiptKind, outcome.receiptId, outcome.receipt);
    return std::move(outcome.command);
  }

private:
  GymState& state_;
  std::string name_;
};

GymProduct::GymProduct(GymState& state) : rules_(std::make_unique<Rules>(state)) {
  for (const char* name : {"gym.start", "gym.importSession", "gym.correctSession", "gym.finish", "gym.applyProposal", "gym.dismissProposal", "gym.closeStale"}) commands_.push_back(std::make_unique<Command>(state, name));
}

GymProduct::~GymProduct() = default;

void GymProduct::bindTo(SyncCatalog& catalog, const std::map<std::string, TypeStore*>& stores) {
  for (const auto& [name, store] : stores) catalog.bindType(*store, rules_.get());
  for (const auto& command : commands_) catalog.bindCommand(command->name(), *command);
}

}
