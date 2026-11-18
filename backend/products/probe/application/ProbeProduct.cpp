#include "products/probe/application/ProbeProduct.h"

#include "platform/domain/sync/Scope.h"
#include "platform/domain/sync/Wire.h"
#include "products/probe/domain/ProbeRules.h"

#include <optional>
#include <utility>
#include <vector>

namespace wm::probe {

using namespace sync;

namespace {

Delta runDelta(const std::string& id) {
  return Delta{.t = "run", .id = RecordId(id)};
}

// The alive row `holds` picks, the least id first: the subtree a step owns, or the tag a label names.
template <typename Holds>
std::optional<Row> aliveWhere(const std::vector<Row>& rows, Holds holds) {
  std::optional<Row> picked;
  for (const Row& row : rows) {
    if (row.alive() && holds(row) && (!picked || row.id.column() < picked->id.column())) picked = row;
  }
  return picked;
}

bool holdsField(const Row& row, const std::string& field, const Json::Value& value) {
  const auto found = row.lattice.f.find(field);
  return found != row.lattice.f.end() && found->second.value == value;
}

// A resolution to a record that exists already: `from` the called id when it differs.
CommandOutcome resolvedTo(const std::string& type, const Row& row, const std::string& called) {
  WriteEntry entry{.t = type, .id = row.id, .born = row.lattice.born};
  if (row.id.column() != called) entry.from = RecordId(called);
  return CommandOutcome{.write = {entry}};
}

// A record the command creates at the server stamp, with one field.
CommandOutcome createdWith(const std::string& type, const std::string& id, const std::string& field, const Json::Value& value) {
  Delta created{.t = type, .id = RecordId(id)};
  created.lattice.life = Life(LifeState::alive, Stamp{});
  created.lattice.born = Stamp{};
  created.lattice.f.emplace(field, Reg(value, Stamp{}));
  return CommandOutcome{.deltas = {created}, .write = {WriteEntry{.t = type, .id = RecordId(id), .born = Stamp{}, .f = {{field, Stamp{}}}}}};
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

  std::set<ScopeKey> discoverEffectScopes(const CommandCtx& ctx) override {
    if (receipts_.copiedFrom(ctx.txn, ctx.scope.key, ctx.args["dst"].asString()) == ctx.args["src"].asString()) return {};
    if (ctx.read.lock("board", RecordId(ctx.args["dst"])).state.kind != IdState::Kind::none) return {};
    return {ScopeKey::tree(ctx.args["dst"].asString())};
  }

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

// probe.branch {parent, child, title}: creates board child and titles both trees; its receipt resolves a replay
// from any replica to the board it created.
class ProbeProduct::Branch final : public SyncCommand {
public:
  explicit Branch(ProbeReceipts& receipts) : receipts_(receipts) {}

  std::set<ScopeKey> discoverEffectScopes(const CommandCtx& ctx) override {
    return {ScopeKey::tree(ctx.args["parent"].asString()), ScopeKey::tree(ctx.args["child"].asString())};
  }

  bool isReplay(CommandCtx& ctx) override {
    return receipts_.branched(ctx.txn, ctx.scope.key, ctx.args["child"].asString()) == receiptOf(ctx);
  }

  CommandOutcome run(CommandCtx& ctx) override {
    const std::string parent = ctx.args["parent"].asString();
    const std::string child = ctx.args["child"].asString();
    if (isReplay(ctx)) {
      const std::optional<Row>& created = ctx.read.lock("board", RecordId(child)).stored;
      CommandOutcome replayed;
      if (created && created->alive()) replayed.write = {WriteEntry{.t = "board", .id = created->id, .born = created->lattice.born}};
      replayed.detail["created"] = false;
      return replayed;
    }
    if (parent == child) throw Refusal(code::invalid);
    if (ctx.read.lock("board", RecordId(child)).stored) throw Refusal(code::idTaken);
    receipts_.recordBranch(ctx.txn, ctx.scope.key, child, receiptOf(ctx));
    Delta board{.t = "board", .id = RecordId(child)};
    board.lattice.born = Stamp{};
    board.lattice.life = Life(LifeState::alive, Stamp{});
    Delta meta{.t = "meta", .id = RecordId(std::string("meta"))};
    meta.lattice.f.emplace("title", Reg(ctx.args["title"], Stamp{}));
    CommandOutcome outcome{.deltas = {board},
      .into = {{ScopeKey::tree(parent), {meta}}, {ScopeKey::tree(child), {meta}}},
      .write = {{.t = "board", .id = RecordId(child), .born = Stamp{}}}};
    outcome.detail["created"] = true;
    return outcome;
  }

private:
  static BranchReceipt receiptOf(const CommandCtx& ctx) { return BranchReceipt{ctx.args["parent"].asString(), ctx.args["title"].asString()}; }

  ProbeReceipts& receipts_;
};

// probe.sprout {board, tag, child}: creates board child owned by the step {board, tag}, its parent, or answers
// the board the step already owns, so a retry or another device's sprout resolves to that subtree. Neither the
// board nor the tag need exist (E-8).
class ProbeProduct::Sprout final : public SyncCommand {
public:
  bool isReplay(CommandCtx& ctx) override { return owned(ctx).has_value(); }

  CommandOutcome run(CommandCtx& ctx) override {
    const std::string child = ctx.args["child"].asString();
    if (const std::optional<Row> board = owned(ctx)) return resolvedTo("board", *board, child);
    if (ctx.read.lock("board", RecordId(child)).state.kind != IdState::Kind::none) throw Refusal(code::idTaken);
    return createdWith("board", child, "parent", stepOf(ctx));
  }

private:
  static Json::Value stepOf(const CommandCtx& ctx) {
    Json::Value step(Json::objectValue);
    step["board"] = ctx.args["board"];
    step["tag"] = ctx.args["tag"];
    return step;
  }

  static std::optional<Row> owned(CommandCtx& ctx) {
    const Json::Value step = stepOf(ctx);
    return aliveWhere(ctx.read.scan("board"), [&step](const Row& row) { return holdsField(row, "parent", step); });
  }
};

// probe.adopt {tag, label}: answers the tree's alive tag labelled `label`, a map of a scope-local id, or
// creates tag `tag` with that label.
class ProbeProduct::Adopt final : public SyncCommand {
public:
  bool isReplay(CommandCtx& ctx) override { return labelled(ctx).has_value(); }

  CommandOutcome run(CommandCtx& ctx) override {
    const std::string tag = ctx.args["tag"].asString();
    if (const std::optional<Row> named = labelled(ctx)) return resolvedTo("tag", *named, tag);
    if (ctx.read.lock("tag", RecordId(tag)).state.kind != IdState::Kind::none) throw Refusal(code::idTaken);
    return createdWith("tag", tag, "label", ctx.args["label"]);
  }

private:
  static std::optional<Row> labelled(CommandCtx& ctx) {
    const Json::Value label = ctx.args["label"];
    return aliveWhere(ctx.read.scan("tag"), [&label](const Row& row) { return holdsField(row, "label", label); });
  }
};

ProbeProduct::ProbeProduct(ProbeReceipts& receipts)
    : runRules_(std::make_unique<RunRules>()),
      start_(std::make_unique<Start>(receipts)),
      end_(std::make_unique<End>()),
      copy_(std::make_unique<Copy>(receipts)),
      tick_(std::make_unique<Tick>()),
      branch_(std::make_unique<Branch>(receipts)),
      sprout_(std::make_unique<Sprout>()),
      adopt_(std::make_unique<Adopt>()) {}

ProbeProduct::~ProbeProduct() = default;

void ProbeProduct::bindTo(SyncCatalog& catalog, const std::map<std::string, TypeStore*>& stores) {
  for (const auto& [name, store] : stores) catalog.bindType(*store, name == "run" ? runRules_.get() : nullptr);
  catalog.bindCommand("probe.start", *start_);
  catalog.bindCommand("probe.end", *end_);
  catalog.bindCommand("probe.copy", *copy_);
  catalog.bindCommand("probe.tick", *tick_);
  catalog.bindCommand("probe.branch", *branch_);
  catalog.bindCommand("probe.sprout", *sprout_);
  catalog.bindCommand("probe.adopt", *adopt_);
}

}
