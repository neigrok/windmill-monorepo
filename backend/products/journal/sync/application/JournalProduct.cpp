#include "products/journal/sync/application/JournalProduct.h"

#include "products/journal/sync/domain/JournalRules.h"

namespace wm::journal::engine {

using namespace sync;

class JournalProduct::Rules final : public TypeRules {
public:
  std::vector<Delta> check(const CheckCtx& ctx, const std::vector<Change>&) override {
    return checkJournal(ctx.intent);
  }
};

class JournalProduct::Command final : public SyncCommand {
public:
  Command(JournalState& state, std::string name) : state_(state), name_(std::move(name)) {}

  bool isReplay(CommandCtx& ctx) override {
    return name_ == "journal.claimPage" && state_.load(ctx.txn, ctx.scope.key)["claims"].isMember(ctx.args["claimId"].asString());
  }

  CommandOutcome run(CommandCtx& ctx) override {
    const Locked& locked = ctx.read.lock("page", RecordId(ctx.args["day"]));
    auto outcome = runJournal(name_, ctx.args, ctx.rawArgs, locked.stored ? &*locked.stored : nullptr,
                              state_.load(ctx.txn, ctx.scope.key), ctx.serverNow);
    if (!outcome.claimId.empty()) {
      state_.receipt(ctx.txn, ctx.scope.key, outcome.claimId, outcome.receipt);
      state_.saveClock(ctx.txn, ctx.scope.key, outcome.contentClock);
    }
    return std::move(outcome.command);
  }

private:
  JournalState& state_;
  std::string name_;
};

JournalProduct::JournalProduct(JournalState& state) : rules_(std::make_unique<Rules>()) {
  for (const char* name : {"journal.savePage", "journal.claimPage"}) commands_.push_back(std::make_unique<Command>(state, name));
}

JournalProduct::~JournalProduct() = default;

void JournalProduct::bindTo(SyncCatalog& catalog, const std::map<std::string, TypeStore*>& stores) {
  for (const auto& [name, store] : stores) catalog.bindType(*store, rules_.get());
  catalog.bindCommand("journal.savePage", *commands_[0]);
  catalog.bindCommand("journal.claimPage", *commands_[1]);
}

}
