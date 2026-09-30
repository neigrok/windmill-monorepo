#include "products/probe/application/ProbeProduct.h"

#include "platform/domain/sync/Scope.h"
#include "platform/domain/sync/Wire.h"
#include "products/probe/domain/ProbeRules.h"

#include <utility>

namespace wm::probe {

using namespace sync;

namespace {

Delta runDelta(const std::string& id) {
  return Delta{.t = "run", .id = RecordId(id)};
}

}

class ProbeProduct::RunRules final : public TypeRules {
public:
  std::vector<Delta> check(const CheckCtx& ctx, const std::vector<Change>& changes) override {
    requireStartedRuns(changes);
    return lapsDyingWithRuns(changes, ctx.read.scan("lap"));
  }
};

// probe.start {id, label?, startedAt, join}: resolves by its receipt, joins the open run, or creates one.
class ProbeProduct::Start final : public SyncCommand {
public:
  explicit Start(ProbeReceipts& receipts) : receipts_(receipts) {}

  bool isReplay(CommandCtx& ctx) override {
    return receipts_.startedRun(ctx.txn, ctx.scope.key, ctx.args["id"].asString()).has_value();
  }

  CommandOutcome run(CommandCtx& ctx) override {
    const std::string called = ctx.args["id"].asString();
    if (const std::optional<std::string> resolved = receipts_.startedRun(ctx.txn, ctx.scope.key, called)) {
      const std::optional<Row>& run = ctx.read.lock("run", RecordId(*resolved)).stored;
      if (!run || !run->alive()) return CommandOutcome{};
      WriteEntry entry{.t = "run", .id = run->id, .born = run->lattice.born};
      if (*resolved != called) entry.from = RecordId(called);
      return CommandOutcome{.write = {entry}};
    }
    for (const Row& open : ctx.read.scan("run")) {
      if (!isOpen(open)) continue;
      if (!ctx.args["join"].asBool()) throw Refusal(code::invalid);
      receipts_.recordStart(ctx.txn, ctx.scope.key, called, open.id.column());
      return CommandOutcome{.write = {WriteEntry{.t = "run", .id = open.id, .from = RecordId(called), .born = open.lattice.born}}};
    }
    receipts_.recordStart(ctx.txn, ctx.scope.key, called, called);
    Delta created = runDelta(called);
    created.lattice.life = Life(LifeState::alive, Stamp{});
    created.lattice.born = Stamp{};
    created.lattice.f.emplace("startedAt", Reg(ctx.args["startedAt"], Stamp{}));
    WriteEntry entry{.t = "run", .id = RecordId(called), .born = Stamp{}, .f = {{"startedAt", Stamp{}}}};
    if (ctx.args.isMember("label")) {
      created.lattice.f.emplace("label", Reg(ctx.args["label"], Stamp{}));
      entry.f.emplace("label", Stamp{});
    }
    return CommandOutcome{.deltas = {created}, .write = {entry}};
  }

private:
  ProbeReceipts& receipts_;
};

// probe.end {runId, endedAt}.
class ProbeProduct::End final : public SyncCommand {
public:
  bool isReplay(CommandCtx&) override { return false; }

  CommandOutcome run(CommandCtx& ctx) override {
    const RecordId runId(ctx.args["runId"]);
    const Locked& locked = ctx.read.lock("run", runId);
    if (!locked.state.exists()) throw Refusal(code::unknownRecord);
    if (locked.state.kind == IdState::Kind::dead) throw Refusal(code::recordDead);
    const Row& run = *locked.stored;
    if (ctx.args["endedAt"].asDouble() < run.lattice.f.at("startedAt").value.asDouble()) throw Refusal(code::invalid);
    if (!isOpen(run)) return CommandOutcome{};
    Delta ended = runDelta(runId.column());
    ended.lattice.born = run.lattice.born;
    ended.lattice.f.emplace("endedAt", Reg(ctx.args["endedAt"], Stamp{}));
    return CommandOutcome{.deltas = {ended}, .write = {WriteEntry{.t = "run", .id = runId, .f = {{"endedAt", Stamp{}}}}}};
  }
};

// probe.copy {src, dst}: creates board dst and writes the source tree into the tree that creates.
class ProbeProduct::Copy final : public SyncCommand {
public:
  explicit Copy(ProbeReceipts& receipts) : receipts_(receipts) {}

  bool isReplay(CommandCtx& ctx) override {
    return receipts_.copiedFrom(ctx.txn, ctx.scope.key, ctx.args["dst"].asString()) == ctx.args["src"].asString();
  }

  CommandOutcome run(CommandCtx& ctx) override {
    const std::string source = ctx.args["src"].asString();
    const std::string destination = ctx.args["dst"].asString();
    if (receipts_.copiedFrom(ctx.txn, ctx.scope.key, destination) == source) {
      const std::optional<Row>& board = ctx.read.lock("board", RecordId(destination)).stored;
      if (!board || !board->alive()) return CommandOutcome{};
      return CommandOutcome{.write = {WriteEntry{.t = "board", .id = board->id, .born = board->lattice.born}}};
    }
    const ScopeKey sourceTree = ScopeKey::tree(source);
    const std::optional<ScopeRow> tree = ctx.read.scope(sourceTree);
    const std::optional<ScopeFacts> facts = tree ? std::optional(tree->facts()) : std::nullopt;
    if (!accessOf(sourceTree, facts, facts, ctx.caller.account).read) throw Refusal(code::notFound);
    if (ctx.read.lock("board", RecordId(destination)).state.kind != IdState::Kind::none) throw Refusal(code::idTaken);
    receipts_.recordCopy(ctx.txn, ctx.scope.key, destination, source);

    std::vector<Row> sourceRows;
    for (const char* type : {"meta", "tag", "link"}) {
      std::vector<Row> rows = ctx.read.scanScope(sourceTree, type);
      sourceRows.insert(sourceRows.end(), std::make_move_iterator(rows.begin()), std::make_move_iterator(rows.end()));
    }
    Delta board{.t = "board", .id = RecordId(destination)};
    board.lattice.life = Life(LifeState::alive, Stamp{});
    board.lattice.born = Stamp{};
    return CommandOutcome{.deltas = {board},
                          .into = {IntoScope{ScopeKey::tree(destination), copyOfTree(sourceRows)}},
                          .write = {WriteEntry{.t = "board", .id = RecordId(destination), .born = Stamp{}}}};
  }

private:
  ProbeReceipts& receipts_;
};

// probe.tick {}: before every pull of the product scope, open runs started kTickAfterMs ago end.
class ProbeProduct::Tick final : public SyncCommand {
public:
  bool isReplay(CommandCtx&) override { return false; }

  CommandOutcome run(CommandCtx& ctx) override {
    CommandOutcome outcome;
    for (const Row& run : ctx.read.scan("run")) {
      if (!isOpen(run) || run.lattice.f.at("startedAt").value.asDouble() > static_cast<double>(ctx.serverNow) - kTickAfterMs) continue;
      Delta ended = runDelta(run.id.column());
      ended.lattice.born = run.lattice.born;
      ended.lattice.f.emplace("endedAt", Reg(Json::UInt64(ctx.serverNow), Stamp{}));
      outcome.deltas.push_back(std::move(ended));
    }
    return outcome;
  }
};

ProbeProduct::ProbeProduct(ProbeReceipts& receipts)
    : runRules_(std::make_unique<RunRules>()),
      start_(std::make_unique<Start>(receipts)),
      end_(std::make_unique<End>()),
      copy_(std::make_unique<Copy>(receipts)),
      tick_(std::make_unique<Tick>()) {}

ProbeProduct::~ProbeProduct() = default;

void ProbeProduct::bindTo(SyncCatalog& catalog, const std::map<std::string, TypeStore*>& stores) {
  for (const auto& [name, store] : stores) catalog.bindType(*store, name == "run" ? runRules_.get() : nullptr);
  catalog.bindCommand("probe.start", *start_);
  catalog.bindCommand("probe.end", *end_);
  catalog.bindCommand("probe.copy", *copy_);
  catalog.bindCommand("probe.tick", *tick_);
}

}
