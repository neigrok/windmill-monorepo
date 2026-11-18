#include "products/roadmap/sync/RoadmapProduct.h"

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Restore.h"
#include "platform/domain/sync/Scope.h"
#include "products/roadmap/sync/RoadmapRules.h"

#include <algorithm>
#include <array>
#include <optional>
#include <set>
#include <utility>

namespace wm::roadmap::engine {

using namespace sync;

const Registry& registry() {
  static const Registry roadmap{parseJson(registryText())};
  return roadmap;
}

namespace {

constexpr std::array<const char*, 4> kOwnerOnly{"pointer", "subtask", "stepLink", "stepNote"};
constexpr std::array<const char*, 4> kWriterTerminal{"completed", "declined", "failed", "stopped"};
constexpr std::array<const char*, 4> kFinalRegisters{"state", "text", "calls", "receipts"};
constexpr std::array<const char*, 2> kRevivedByAChange{"node", "kind"};
// The product-scope commands whose own discovery declares every scope they and their consequences reach.
constexpr std::array<const char*, 4> kSelfDeclaring{"roadmap.createSubtree", "roadmap.redoCreateSubtree", "roadmap.undoCreateSubtree",
                                                    "roadmap.undoCreateRoadmap"};

template <std::size_t N>
bool among(const std::array<const char*, N>& names, const std::string& name) {
  return std::any_of(names.begin(), names.end(), [&](const char* each) { return name == each; });
}

ScopeKey accountOf(const UserId& account) {
  return ScopeKey::product(account, "roadmap");
}

RecordId metaId() {
  return RecordId(std::string("meta"));
}

bool died(const Change& change) {
  return present(change.stored) && !present(change.after);
}

std::string reachIn(const std::optional<Row>& meta) {
  const Json::Value reach = valueOf(meta, "reach");
  return reach.isString() ? reach.asString() : "private";
}

// A delta writing `row`'s life at the server stamp.
Delta lifeOf(const Row& row, LifeState state) {
  Delta delta{.t = row.t, .id = row.id};
  delta.lattice.born = row.lattice.born;
  delta.lattice.life = Life(state, Stamp{});
  return delta;
}

// A write of a record of a type with life whatever its life: a dead one keeps its stored life, so the write revives
// nothing.
Delta written(const Row& row, const std::map<std::string, Json::Value>& fields) {
  Delta delta{.t = row.t, .id = row.id};
  delta.lattice.born = row.lattice.born;
  if (!present(row)) delta.lattice.life = row.lattice.life;
  for (const auto& [name, value] : fields) delta.lattice.f.emplace(name, Reg(value, Stamp{}));
  return delta;
}

Delta metaWith(const std::map<std::string, Json::Value>& fields) {
  Delta delta{.t = "meta", .id = metaId()};
  for (const auto& [name, value] : fields) delta.lattice.f.emplace(name, Reg(value, Stamp{}));
  return delta;
}

// The alive pointers of the owner's overlay of `tree` that open one of `roots`, the least step first.
std::vector<Row> openers(SyncReader& read, const UserId& account, const std::string& tree, const std::vector<std::string>& roots) {
  std::vector<Row> opening;
  for (Row& pointer : read.scanScope(ScopeKey::overlay(account, tree), "pointer")) {
    const Json::Value opens = valueOf(pointer, "opens");
    if (present(pointer) && opens.isString() && std::find(roots.begin(), roots.end(), opens.asString()) != roots.end()) opening.push_back(std::move(pointer));
  }
  std::sort(opening.begin(), opening.end(), [](const Row& a, const Row& b) { return a.id.column() < b.id.column(); });
  return opening;
}

// §2.3 discovery: the scopes an intent's consequences reach, read from the owner's roadmaps as they stand before it.
class Reached {
public:
  Reached(SyncReader& read, const UserId& account) : read_(read), account_(account), roadmaps_(read.scanScope(accountOf(account), "tree")) {}

  void add(const ScopeKey& key) { keys_.insert(key); }

  // tree:<tree>, while its scope is alive.
  void declare(const std::string& tree) {
    const std::optional<ScopeRow> scope = read_.scope(ScopeKey::tree(tree));
    if (scope && !scope->dead) keys_.insert(ScopeKey::tree(tree));
  }

  void under(const std::string& tree) {
    for (const std::string& id : roadmaps_.under(tree)) declare(id);
  }

  void branch(const std::string& tree, const std::string& step) {
    for (const std::string& id : roadmaps_.branchOf(tree, step)) declare(id);
  }

  // The deaths of alive roots among `deaths`: every other alive roadmap of the owner's whose overlay holds a pointer
  // opening one, that overlay, and the branches of those steps.
  void rootDeaths(const std::vector<std::string>& deaths) {
    std::vector<std::string> roots;
    for (const std::string& id : deaths) {
      if (roadmaps_.isAlive(id) && !roadmaps_.placeOf(id)) roots.push_back(id);
    }
    if (roots.empty()) return;
    std::set<std::string> lost(roots.begin(), roots.end());
    for (const std::string& root : roots) {
      for (const std::string& id : roadmaps_.under(root)) lost.insert(id);
    }
    for (const std::string& tree : roadmaps_.ids()) {
      if (!roadmaps_.isAlive(tree) || lost.contains(tree)) continue;
      const std::vector<Row> opening = openers(read_, account_, tree, roots);
      if (opening.empty()) continue;
      add(ScopeKey::overlay(account_, tree));
      declare(tree);
      for (const Row& pointer : opening) branch(tree, pointer.id.column());
    }
  }

  std::set<ScopeKey> keys() const { return keys_; }

private:
  SyncReader& read_;
  const UserId& account_;
  Roadmaps roadmaps_;
  std::set<ScopeKey> keys_;
};

// The records of the declared scopes as the intent leaves them: stored, then joined, then what the rules append.
class Outcome {
public:
  Outcome(SyncReader& read, const std::vector<Change>& changes) : read_(read) {
    for (const Change& change : changes) rows_.insert_or_assign(RecordRef{change.scope, change.after.t, change.after.id}, change.after);
  }

  std::optional<Row> row(const ScopeKey& scope, const std::string& type, const RecordId& id) {
    const auto found = rows_.find(RecordRef{scope, type, id});
    if (found != rows_.end()) return found->second;
    return read_.lockIn(scope, type, id).stored;
  }

  std::vector<Row> rows(const ScopeKey& scope, const std::string& type) {
    std::map<std::string, Row> rows;
    for (Row& stored : read_.scanScope(scope, type)) rows.insert_or_assign(stored.id.key(), std::move(stored));
    for (const auto& [ref, row] : rows_) {
      if (ref.scope == scope && ref.t == type) rows.insert_or_assign(ref.id.key(), row);
    }
    std::vector<Row> all;
    for (auto& [key, row] : rows) all.push_back(std::move(row));
    return all;
  }

  void append(const ScopeKey& scope, Delta delta) {
    Row joined = row(scope, delta.t, delta.id).value_or(Row(delta.t, delta.id));
    if (delta.lattice.life) joined.lattice.life = delta.lattice.life;
    for (const auto& [name, reg] : delta.lattice.f) joined.lattice.f.insert_or_assign(name, reg);
    rows_.insert_or_assign(RecordRef{scope, delta.t, delta.id}, std::move(joined));
    if (delta.t == "node") appendedSteps_.emplace_back(scope, delta.id);
    effects_.byScope[scope].push_back(std::move(delta));
  }

  void kill(const ScopeKey& scope, const Row& record) {
    if (present(row(scope, record.t, record.id))) append(scope, lifeOf(record, LifeState::dead));
  }

  const std::vector<std::pair<ScopeKey, RecordId>>& appendedSteps() const { return appendedSteps_; }
  Effects effects() const { return effects_; }

private:
  SyncReader& read_;
  std::map<RecordRef, Row> rows_;
  std::vector<std::pair<ScopeKey, RecordId>> appendedSteps_;
  Effects effects_;
};

bool writesField(const Intent& intent, const std::string& type, const std::string& field) {
  return std::any_of(intent.d.begin(), intent.d.end(), [&](const Delta& delta) { return delta.t == type && delta.lattice.f.contains(field); });
}

bool sameRegister(const std::optional<Row>& a, const std::optional<Row>& b, const std::string& field) {
  auto registerOf = [&](const std::optional<Row>& row) -> Json::Value {
    if (!row) return Json::Value(Json::nullValue);
    const auto reg = row->lattice.f.find(field);
    return reg == row->lattice.f.end() ? Json::Value(Json::nullValue) : reg->second.toJson();
  };
  return jcs(registerOf(a)) == jcs(registerOf(b));
}

bool names(const Json::Value& list, const char* member, const Json::Value& expected) {
  return std::any_of(list.begin(), list.end(), [&](const Json::Value& item) { return jcs(item[member]) == jcs(expected); });
}

Json::Value record(const std::string& scope, const std::string& type, const std::string& id) {
  Json::Value address(Json::objectValue);
  address["scope"] = scope;
  address["t"] = type;
  address["id"] = id;
  return address;
}

// The step's `branch` register, as an inverse's evidence names it.
Json::Value branchTarget(const std::string& tree, const std::string& step) {
  Json::Value target = record("tree/" + tree, "node", step);
  target["slot"]["kind"] = "field";
  target["slot"]["name"] = "branch";
  return target;
}

// What an inverse's evidence reads: a row of a scope the intent declared and that is alive, else nothing, and any
// scope's sequence.
EvidenceReader evidenceReader(CommandCtx& ctx) {
  auto keyOf = [&ctx](const std::string& ref) { return resolve(ctx.registry, ref, ctx.caller.account); };
  return EvidenceReader{
      .row = [&ctx, keyOf](const std::string& scope, const std::string& type, const RecordId& id) -> std::optional<Row> {
        const std::optional<ScopeKey> key = keyOf(scope);
        if (!key || !ctx.read.declared(*key)) return std::nullopt;
        const std::optional<ScopeRow> row = ctx.read.scope(*key);
        if (!row || row->dead) return std::nullopt;
        return ctx.read.lockIn(*key, type, id).stored;
      },
      .seq = [&ctx, keyOf](const std::string& scope) -> std::optional<Seq> {
        const std::optional<ScopeKey> key = keyOf(scope);
        const std::optional<ScopeRow> row = key ? ctx.read.scope(*key) : std::nullopt;
        return row ? std::optional<Seq>(row->seq) : std::nullopt;
      },
  };
}

Seq overlaySeq(CommandCtx& ctx, const std::string& tree) {
  const std::optional<ScopeRow> overlay = ctx.read.scope(ScopeKey::overlay(ctx.caller.account, tree));
  return overlay ? overlay->seq : 0;
}

// A subtree's arguments: the roadmap holding the step, its root, the step and the subtree's proposed id.
struct Subtree {
  std::string tree;
  std::string root;
  std::string step;
  std::string subtree;

  static Subtree of(const Json::Value& args) {
    return Subtree{args["tree"].asString(), args["root"].asString(), args["step"].asString(), args["subtree"].asString()};
  }
};

std::int64_t depthUnder(const std::optional<Row>& holder) {
  const Json::Value depth = valueOf(holder, "depth");
  return (depth.isIntegral() ? depth.asInt64() : 0) + 1;
}

// createSubtree steps 5 and 6 (A.1): the subtree's `tree` record placed at the step, which creates its scope; in it the
// subtree's meta, one below its holder with the holder's reach, and the genesis kinds; and the step's `branch`, which
// revives it when it was deleted elsewhere.
CommandOutcome plant(CommandCtx& ctx, const Subtree& args, const std::optional<Row>& node) {
  if (!node) throw Refusal(code::unknownRecord);
  const ScopeKey holderScope = ScopeKey::tree(args.tree);
  const std::optional<Row> holder = ctx.read.lockIn(holderScope, "meta", metaId()).stored;
  const Json::Value root = valueOf(holder, "root");
  if (args.root != (root.isString() ? root.asString() : args.tree)) throw Refusal(code::invalid);
  if (ctx.read.lock("tree", RecordId(args.subtree)).state.kind != IdState::Kind::none) throw Refusal(code::idTaken);

  const Json::Value place = Place{args.tree, args.step}.toJson();
  Delta created{.t = "tree", .id = RecordId(args.subtree)};
  created.lattice.born = Stamp{};
  created.lattice.life = Life(LifeState::alive, Stamp{});
  created.lattice.f.emplace("parent", Reg(place, Stamp{}));

  Delta branch = written(*node, {{"branch", args.subtree}});
  if (!present(node)) branch.lattice.life = Life(LifeState::alive, Stamp{});

  std::vector<Delta> born{metaWith({{"root", args.root}, {"parent", place}, {"depth", Json::Int64(depthUnder(holder))}, {"reach", reachIn(holder)}})};
  for (const GenesisKind& genesis : kGenesisKinds) {
    Delta kind{.t = "kind", .id = RecordId(std::string(genesis.id))};
    kind.lattice.born = Stamp{};
    kind.lattice.life = Life(LifeState::alive, Stamp{});
    kind.lattice.f.emplace("hue", Reg(Json::Value(genesis.hue), Stamp{}));
    kind.lattice.f.emplace("label", Reg(Json::Value(genesis.label), Stamp{}));
    kind.lattice.f.emplace("description", Reg(Json::Value(genesis.description), Stamp{}));
    kind.lattice.f.emplace("ord", Reg(Json::Value(genesis.ord), Stamp{}));
    born.push_back(std::move(kind));
  }
  return CommandOutcome{.deltas = {created},
                        .into = {IntoScope{holderScope, {branch}}, IntoScope{ScopeKey::tree(args.subtree), std::move(born)}},
                        .write = {WriteEntry{.t = "tree", .id = RecordId(args.subtree), .born = Stamp{}, .f = {{"parent", Stamp{}}}}}};
}

}

// Appendix A.1's rules on the joined records of one intent, every roadmap type's: each type's rule, the server's revival
// of a changed step or kind, the end of a roadmap's branch, a root's visibility and the reach of its branch. Discovery
// declares every scope they reach before any of them runs.
class RoadmapProduct::Rules final : public TypeRules {
public:
  std::set<ScopeKey> discoverEffectScopes(const CheckCtx& ctx) override {
    const ScopeKey& origin = ctx.scope.key;
    const UserId& account = ctx.caller.account;
    if (origin.kind() == ScopeKind::tree) {
      const Json::Value restored = ctx.intent.cmd && ctx.intent.cmd->name == "roadmap.restoreTree" ? ctx.intent.cmd->args["operations"] : Json::Value(Json::arrayValue);
      const bool visible = writesField(ctx.intent, "meta", "visibility") || std::any_of(restored.begin(), restored.end(), [](const Json::Value& op) {
        return op["t"] == "meta" && op["slot"]["name"] == "visibility";
      });
      std::vector<std::string> steps;
      for (const Delta& delta : ctx.intent.d) {
        if (delta.t == "node" && delta.lattice.life) steps.push_back(delta.id.column());
      }
      for (const Json::Value& op : restored) {
        if (op["t"] == "node" && (op["kind"] != "field" || op["slot"]["kind"] == "life")) steps.push_back(op["id"].asString());
      }
      if (!visible && steps.empty()) return {};
      Reached reached(ctx.read, account);
      reached.add(accountOf(account));
      if (visible) reached.under(origin.treeId());
      for (const std::string& step : steps) reached.branch(origin.treeId(), step);
      return reached.keys();
    }
    if (origin != accountOf(account) || (ctx.intent.cmd && among(kSelfDeclaring, ctx.intent.cmd->name))) return {};
    std::vector<std::string> deaths;
    for (const Delta& delta : ctx.intent.d) {
      if (delta.t == "tree" && delta.lattice.life && !delta.lattice.life->alive()) deaths.push_back(delta.id.column());
    }
    if (deaths.empty()) return {};
    Reached reached(ctx.read, account);
    reached.rootDeaths(deaths);
    return reached.keys();
  }

  Effects effects(const CheckCtx& ctx, const std::vector<Change>& changes) override {
    Outcome outcome(ctx.read, changes);
    for (const Change& change : changes) checkRecord(ctx, change, outcome);
    revive(ctx, outcome);
    if (ctx.scope.key == accountOf(ctx.caller.account)) endBranches(ctx, changes, outcome);
    settleVisibility(ctx, changes, outcome);
    settleReach(ctx, changes, outcome);
    return outcome.effects();
  }

private:
  static void checkRecord(const CheckCtx& ctx, const Change& change, Outcome& outcome) {
    const std::string& type = change.type->name;
    if (type == "tree") return onlyARootIsDeleted(ctx, change);
    if (type == "meta") return checkMeta(ctx, change, outcome);
    if (among(kOwnerOnly, type)) return ownersOnly(ctx, change);
    if (type == "coachThread") return endThread(change, outcome);
    if (type == "coachMessage") return checkMessage(ctx, change, outcome);
  }

  // A person deletes only a root: a subtree goes with the step that owns it.
  static void onlyARootIsDeleted(const CheckCtx& ctx, const Change& change) {
    if (ctx.caller.server || !died(change) || valueOf(change.stored, "parent").isNull()) return;
    const bool killed = std::any_of(ctx.intent.d.begin(), ctx.intent.d.end(), [&](const Delta& delta) {
      return delta.t == "tree" && delta.id == change.after.id && delta.lattice.life && !delta.lattice.life->alive();
    });
    if (killed) throw Refusal(kNotARoot);
  }

  // Only a root has a visibility; the owner's guide replaces one a fork inherited, unless the same intent says it is
  // inherited.
  static void checkMeta(const CheckCtx& ctx, const Change& change, Outcome& outcome) {
    if (change.scope == ctx.scope.key && writesField(ctx.intent, "meta", "visibility")) {
      const Locked& tree = ctx.read.lockIn(accountOf(ctx.caller.account), "tree", RecordId(change.scope.treeId()));
      if (!valueOf(tree.stored, "parent").isNull()) throw Refusal(kNotARoot);
    }
    const Json::Value inherited = valueOf(change.after, "guideInherited");
    if (sameRegister(change.stored, change.after, "guide") || !inherited.isBool() || !inherited.asBool()) return;
    if (writesField(ctx.intent, "meta", "guideInherited")) return;
    outcome.append(change.scope, metaWith({{"guideInherited", false}}));
  }

  // R-3: a pointer and the workspace are admitted only in the overlay of the roadmap's owner.
  static void ownersOnly(const CheckCtx& ctx, const Change& change) {
    const std::optional<ScopeRow> tree = ctx.read.scope(change.scope.governingTree());
    if (!tree || tree->owner != change.scope.account()) throw Refusal(code::forbidden);
  }

  // A Coach conversation's death kills its messages, with their write fates, and its proposals.
  static void endThread(const Change& change, Outcome& outcome) {
    if (!died(change)) return;
    const std::string& thread = change.after.id.column();
    for (const Row& message : outcome.rows(change.scope, "coachMessage")) {
      if (valueOf(message, "threadId") != Json::Value(thread)) continue;
      outcome.kill(change.scope, message);
      endFates(change.scope, message.id.column(), outcome);
    }
    for (const Row& proposal : outcome.rows(change.scope, "coachProposal")) {
      if (valueOf(proposal, "threadId") == Json::Value(thread)) outcome.kill(change.scope, proposal);
    }
  }

  // A message's death kills its write fates; once its writer has ended the turn, its state, text, calls and receipts
  // are final.
  static void checkMessage(const CheckCtx& ctx, const Change& change, Outcome& outcome) {
    if (died(change)) return endFates(change.scope, change.after.id.column(), outcome);
    const Json::Value state = valueOf(change.stored, "state");
    const bool ended = present(change.stored) && state.isString() && among(kWriterTerminal, state.asString());
    if (!ended) return;
    for (const Delta& delta : ctx.intent.d) {
      if (delta.t != "coachMessage" || delta.id != change.after.id) continue;
      for (const auto& [name, reg] : delta.lattice.f) {
        if (among(kFinalRegisters, name)) throw Refusal(kTurnFinal);
      }
    }
  }

  static void endFates(const ScopeKey& scope, const std::string& message, Outcome& outcome) {
    for (const Row& fate : outcome.rows(scope, "coachWriteFate")) {
      if (valueOf(fate, "messageId") == Json::Value(message)) outcome.kill(scope, fate);
    }
  }

  // §5: a change to a step or a kind carries its life as alive; one still dead once it has joined, the delete being
  // newer, the server revives.
  static void revive(const CheckCtx& ctx, Outcome& outcome) {
    for (const Delta& delta : ctx.intent.d) {
      if (!among(kRevivedByAChange, delta.t) || !delta.lattice.life || !delta.lattice.life->alive()) continue;
      const std::optional<Row> row = outcome.row(ctx.scope.key, delta.t, delta.id);
      if (row && !present(row)) outcome.append(ctx.scope.key, lifeOf(*row, LifeState::alive));
    }
  }

  // §4: a roadmap's death kills every subtree under it, and a root's deletes each step of the owner's other roadmaps
  // whose pointer opens it.
  static void endBranches(const CheckCtx& ctx, const std::vector<Change>& changes, Outcome& outcome) {
    const UserId& account = ctx.caller.account;
    const ScopeKey own = accountOf(account);
    std::vector<const Change*> deaths;
    for (const Change& change : changes) {
      if (change.scope == own && change.type->name == "tree" && died(change)) deaths.push_back(&change);
    }
    if (deaths.empty()) return;
    const Roadmaps roadmaps(outcome.rows(own, "tree"));
    std::vector<std::string> roots;
    for (const Change* death : deaths) {
      for (const std::string& id : roadmaps.under(death->after.id.column())) outcome.kill(own, *roadmaps.row(id));
      if (valueOf(death->stored, "parent").isNull()) roots.push_back(death->after.id.column());
    }
    if (roots.empty()) return;
    const Roadmaps standing(outcome.rows(own, "tree"));
    for (const std::string& tree : standing.ids()) {
      if (!standing.isAlive(tree) || !ctx.read.declared(ScopeKey::overlay(account, tree))) continue;
      for (const Row& pointer : openers(ctx.read, account, tree, roots)) {
        const ScopeKey scope = ScopeKey::tree(tree);
        if (const std::optional<Row> step = outcome.row(scope, "node", pointer.id)) outcome.kill(scope, *step);
      }
    }
  }

  // §4: a root's reach is its visibility, so a change of the visibility, by the owner's write or an Undo's restore,
  // writes the root's reach and the reach of every subtree under it, standing ones taking the visibility.
  static void settleVisibility(const CheckCtx& ctx, const std::vector<Change>& changes, Outcome& outcome) {
    const ScopeKey& origin = ctx.scope.key;
    if (origin.kind() != ScopeKind::tree) return;
    const auto meta = std::find_if(changes.begin(), changes.end(), [&](const Change& change) { return change.scope == origin && change.type->name == "meta"; });
    if (meta == changes.end()) return;
    const auto visibilityOf = [](const std::optional<Row>& row) {
      const Json::Value visibility = valueOf(row, "visibility");
      return visibility.isString() ? visibility.asString() : "private";
    };
    const std::string visibility = visibilityOf(meta->after);
    if (visibility == visibilityOf(meta->stored)) return;
    if (reachIn(meta->after) != visibility) outcome.append(origin, metaWith({{"reach", visibility}}));
    const Roadmaps roadmaps(outcome.rows(accountOf(ctx.caller.account), "tree"));
    for (const Reach& reach : reachesOf(roadmaps, roadmaps.under(origin.treeId()), outcome)) {
      outcome.append(ScopeKey::tree(reach.tree), metaWith({{"reach", reach.reach}}));
    }
  }

  // §4: a step's death that ends a subtree's standing writes `reach` private on every subtree under it, and its
  // revival writes the reach of the roadmap above back.
  static void settleReach(const CheckCtx& ctx, const std::vector<Change>& changes, Outcome& outcome) {
    std::vector<std::pair<ScopeKey, RecordId>> steps;
    for (const Change& change : changes) {
      if (change.type->name == "node") steps.emplace_back(change.scope, change.after.id);
    }
    steps.insert(steps.end(), outcome.appendedSteps().begin(), outcome.appendedSteps().end());
    std::vector<std::pair<ScopeKey, RecordId>> flipped;
    for (const auto& [scope, id] : steps) {
      if (present(ctx.read.lockIn(scope, "node", id).stored) != present(outcome.row(scope, "node", id))) flipped.emplace_back(scope, id);
    }
    if (flipped.empty()) return;
    const Roadmaps roadmaps(outcome.rows(accountOf(ctx.caller.account), "tree"));
    std::vector<std::string> subtrees;
    for (const auto& [scope, id] : flipped) {
      for (const std::string& subtree : roadmaps.branchOf(scope.treeId(), id.column())) subtrees.push_back(subtree);
    }
    for (const Reach& reach : reachesOf(roadmaps, subtrees, outcome)) {
      outcome.append(ScopeKey::tree(reach.tree), metaWith({{"reach", reach.reach}}));
    }
  }

  static std::vector<Reach> reachesOf(const Roadmaps& roadmaps, const std::vector<std::string>& subtrees, Outcome& outcome) {
    return reaches(roadmaps, subtrees, [&](const std::string& tree) { return reachIn(outcome.row(ScopeKey::tree(tree), "meta", metaId())); },
                   [&](const Place& step) { return present(outcome.row(ScopeKey::tree(step.tree), "node", RecordId(step.step))); });
  }
};

// roadmap.createSubtree {tree, root, step, subtree} in self/roadmap (A.1).
class RoadmapProduct::CreateSubtree final : public SyncCommand {
public:
  std::set<ScopeKey> discoverEffectScopes(const CommandCtx& ctx) override {
    const Subtree args = Subtree::of(ctx.args);
    Reached reached(ctx.read, ctx.caller.account);
    reached.add(ScopeKey::tree(args.tree));
    reached.add(ScopeKey::tree(args.subtree));
    reached.add(ScopeKey::overlay(ctx.caller.account, args.tree));
    reached.branch(args.tree, args.step);
    return reached.keys();
  }

  // Step 1, the replay rule: the step already owns a subtree.
  bool isReplay(CommandCtx& ctx) override {
    const Subtree args = Subtree::of(ctx.args);
    return !Roadmaps(ctx.read.scan("tree")).ownedBy(args.tree, args.step).empty();
  }

  CommandOutcome run(CommandCtx& ctx) override {
    const Subtree args = Subtree::of(ctx.args);
    const ScopeKey holder = ScopeKey::tree(args.tree);
    const std::optional<Row> node = ctx.read.lockIn(holder, "node", RecordId(args.step)).stored;
    const Roadmaps roadmaps(ctx.read.scan("tree"));
    if (const std::vector<std::string> owned = roadmaps.ownedBy(args.tree, args.step); !owned.empty()) {
      WriteEntry entry{.t = "tree", .id = RecordId(owned.front()), .born = roadmaps.row(owned.front())->lattice.born};
      if (owned.front() != args.subtree) entry.from = RecordId(args.subtree);
      CommandOutcome answered{.write = {entry}};
      if (node && !present(node)) answered.into.push_back(IntoScope{holder, {lifeOf(*node, LifeState::alive)}});
      return answered;
    }
    if (!node) throw Refusal(code::unknownRecord);
    const std::optional<Row> pointer = ctx.read.lockIn(ScopeKey::overlay(ctx.caller.account, args.tree), "pointer", RecordId(args.step)).stored;
    if (present(pointer) && !valueOf(pointer, "opens").isNull()) throw Refusal(kStepOpensATree);
    if (depthUnder(ctx.read.lockIn(holder, "meta", metaId()).stored) > kMaxDepth) throw Refusal(kDepthLimit);
    return plant(ctx, args, node);
  }
};

// roadmap.recolourKind {kind, hue} in tree/<T> (A.1): the kind's hue and the colour of every step wearing it, present or
// not. A kind deleted elsewhere is revived; no step is.
class RoadmapProduct::RecolourKind final : public SyncCommand {
public:
  bool isReplay(CommandCtx&) override { return false; }

  CommandOutcome run(CommandCtx& ctx) override {
    const std::optional<Row> kind = ctx.read.lock("kind", RecordId(ctx.args["kind"])).stored;
    if (!kind) throw Refusal(code::unknownRecord);
    const auto hueOf = [](const std::optional<Row>& row, const char* field) {
      const Json::Value hue = valueOf(row, field);
      return hue.isString() ? hue.asString() : "terracotta";
    };
    const std::string before = hueOf(kind, "hue");
    const Json::Value& hue = ctx.args["hue"];
    if (before == hue.asString()) return CommandOutcome{};
    Delta recoloured = written(*kind, {{"hue", hue}});
    if (!present(kind)) recoloured.lattice.life = Life(LifeState::alive, Stamp{});
    std::vector<Row> wearers = ctx.read.scan("node");
    std::erase_if(wearers, [&](const Row& node) { return hueOf(node, "color") != before; });
    std::sort(wearers.begin(), wearers.end(), [](const Row& a, const Row& b) { return a.id.column() < b.id.column(); });
    CommandOutcome outcome{.deltas = {recoloured}};
    for (const Row& node : wearers) outcome.deltas.push_back(written(node, {{"color", hue}}));
    return outcome;
  }
};

// K-3 roadmap.undoCreateRoadmap {input: {tree}, evidence} (A.1): while the root's record, its tree scope and its owner's
// overlay of it are as the creation left them, the root dies, as any root dies.
class RoadmapProduct::UndoCreateRoadmap final : public SyncCommand {
public:
  std::set<ScopeKey> discoverEffectScopes(const CommandCtx& ctx) override {
    Reached reached(ctx.read, ctx.caller.account);
    reached.rootDeaths({ctx.args["input"]["tree"].asString()});
    return reached.keys();
  }

  bool isReplay(CommandCtx&) override { return false; }

  CommandOutcome run(CommandCtx& ctx) override {
    const std::string tree = ctx.args["input"]["tree"].asString();
    const Json::Value& evidence = ctx.args["evidence"];
    const bool proves = names(evidence["unchangedCreatedRecords"], "record", record("self/roadmap", "tree", tree)) &&
                        names(evidence["unchangedCreatedScopes"], "scope", Json::Value("tree/" + tree));
    if (!proves) throw Refusal(code::invalid);
    if (const std::optional<std::string> skip = evidenceSkip(evidenceReader(ctx), evidence, ctx.epoch)) return CommandOutcome{.detail = inverseDetail(skip)};
    const std::optional<Row> root = ctx.read.lock("tree", RecordId(tree)).stored;
    if (!valueOf(root, "parent").isNull()) throw Refusal(kNotARoot);
    if (overlaySeq(ctx, tree) > 0) return CommandOutcome{.detail = inverseDetail("scope-changed")};
    return CommandOutcome{.deltas = {lifeOf(root.value(), LifeState::dead)}, .detail = inverseDetail(std::nullopt)};
  }
};

// K-3 roadmap.undoCreateSubtree {input: {tree, step, subtree}, evidence} (R-8): while the step's `branch` is the act's
// and the subtree's record, its tree scope and its owner's overlay are as the creation left them, the subtree dies and
// the step's `branch` clears, together.
class RoadmapProduct::UndoCreateSubtree final : public SyncCommand {
public:
  std::set<ScopeKey> discoverEffectScopes(const CommandCtx& ctx) override {
    Reached reached(ctx.read, ctx.caller.account);
    reached.declare(ctx.args["input"]["tree"].asString());
    reached.declare(ctx.args["input"]["subtree"].asString());
    return reached.keys();
  }

  bool isReplay(CommandCtx&) override { return false; }

  CommandOutcome run(CommandCtx& ctx) override {
    const Json::Value& input = ctx.args["input"];
    const std::string tree = input["tree"].asString();
    const std::string step = input["step"].asString();
    const std::string subtree = input["subtree"].asString();
    const Json::Value& evidence = ctx.args["evidence"];
    const bool proves = names(evidence["ownedFields"], "target", branchTarget(tree, step)) &&
                        names(evidence["unchangedCreatedRecords"], "record", record("self/roadmap", "tree", subtree)) &&
                        names(evidence["unchangedCreatedScopes"], "scope", Json::Value("tree/" + subtree));
    if (!proves) throw Refusal(code::invalid);
    if (const std::optional<std::string> skip = evidenceSkip(evidenceReader(ctx), evidence, ctx.epoch)) return CommandOutcome{.detail = inverseDetail(skip)};
    const std::optional<Row> created = ctx.read.lock("tree", RecordId(subtree)).stored;
    if (jcs(valueOf(created, "parent")) != jcs(Place{tree, step}.toJson())) throw Refusal(code::invalid);
    if (overlaySeq(ctx, subtree) > 0) return CommandOutcome{.detail = inverseDetail("scope-changed")};
    const ScopeKey holder = ScopeKey::tree(tree);
    const std::optional<Row> node = ctx.read.lockIn(holder, "node", RecordId(step)).stored;
    return CommandOutcome{.deltas = {lifeOf(created.value(), LifeState::dead)},
                          .into = {IntoScope{holder, {written(node.value(), {{"branch", Json::Value(Json::nullValue)}})}}},
                          .detail = inverseDetail(std::nullopt)};
  }
};

// K-3 roadmap.redoCreateSubtree {input: {tree, root, step, subtree}, evidence} (R-8): while the step's `branch` is still
// the one the Undo wrote, a new subtree under a fresh id, planted as createSubtree plants one; otherwise nothing.
class RoadmapProduct::RedoCreateSubtree final : public SyncCommand {
public:
  std::set<ScopeKey> discoverEffectScopes(const CommandCtx& ctx) override {
    const Subtree args = Subtree::of(ctx.args["input"]);
    Reached reached(ctx.read, ctx.caller.account);
    reached.declare(args.tree);
    reached.add(ScopeKey::tree(args.subtree));
    reached.branch(args.tree, args.step);
    return reached.keys();
  }

  bool isReplay(CommandCtx&) override { return false; }

  CommandOutcome run(CommandCtx& ctx) override {
    const Subtree args = Subtree::of(ctx.args["input"]);
    const Json::Value& evidence = ctx.args["evidence"];
    if (!names(evidence["ownedFields"], "target", branchTarget(args.tree, args.step))) throw Refusal(code::invalid);
    if (const std::optional<std::string> skip = evidenceSkip(evidenceReader(ctx), evidence, ctx.epoch)) return CommandOutcome{.detail = inverseDetail(skip)};
    CommandOutcome planted = plant(ctx, args, ctx.read.lockIn(ScopeKey::tree(args.tree), "node", RecordId(args.step)).stored);
    planted.detail = inverseDetail(std::nullopt);
    return planted;
  }
};

RoadmapProduct::RoadmapProduct() : rules_(std::make_unique<Rules>()) {
  commands_.emplace("roadmap.createSubtree", std::make_unique<CreateSubtree>());
  commands_.emplace("roadmap.recolourKind", std::make_unique<RecolourKind>());
  commands_.emplace("roadmap.undoCreateRoadmap", std::make_unique<UndoCreateRoadmap>());
  commands_.emplace("roadmap.undoCreateSubtree", std::make_unique<UndoCreateSubtree>());
  commands_.emplace("roadmap.redoCreateSubtree", std::make_unique<RedoCreateSubtree>());
}

RoadmapProduct::~RoadmapProduct() = default;

void RoadmapProduct::bindTo(SyncCatalog& catalog, const std::map<std::string, TypeStore*>& stores) {
  for (const auto& [name, store] : stores) catalog.bindType(*store, rules_.get());
  for (const auto& [name, command] : commands_) catalog.bindCommand(name, *command);
}

}
